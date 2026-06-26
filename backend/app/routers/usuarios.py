"""
Gestão de usuários (somente ADMINISTRADOR).

GET    /api/admin/usuarios          -> lista usuários
POST   /api/admin/usuarios          -> cria usuário (com papel/supervisor)
PUT    /api/admin/usuarios/{id}     -> edita (papel, supervisor, ativar/desativar, senha)
GET    /api/admin/usuarios/organograma -> árvore hierárquica

Regras importantes:
- Trocar papel, desativar ou redefinir senha INCREMENTA token_version, o que
  revoga imediatamente as sessões antigas do usuário (efeito instantâneo).
- Prevenção de ciclo: um usuário não pode ser supervisor de si mesmo nem de um
  ancestral (evita loop na árvore).
"""
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.services import auditoria
from app.security.auth import exigir_admin, gerar_hash_senha, ip_requisicao
from app.database import get_db
from app.models import (
    Anexo,
    Artigo,
    ArtigoVoto,
    Auditoria,
    Chamado,
    Comentario,
    NivelAcesso,
    Notificacao,
    Papel,
    Usuario,
)
from app.schemas import UsuarioAtualizar, UsuarioCriar, UsuarioResposta

router = APIRouter(prefix="/api/admin/usuarios", tags=["Usuários"])


def _causaria_ciclo(db: Session, usuario_id: int, novo_supervisor_id: int) -> bool:
    """True se definir novo_supervisor criaria um ciclo na hierarquia."""
    atual = novo_supervisor_id
    visitados = set()
    while atual is not None and atual not in visitados:
        if atual == usuario_id:
            return True
        visitados.add(atual)
        sup = db.query(Usuario.supervisor_id).filter(Usuario.id == atual).first()
        atual = sup[0] if sup else None
    return False


@router.get("", response_model=list[UsuarioResposta])
def listar(db: Session = Depends(get_db), _: Usuario = Depends(exigir_admin)):
    return db.query(Usuario).order_by(Usuario.nome).all()


@router.post("", response_model=UsuarioResposta, status_code=201)
def criar(
    dados: UsuarioCriar,
    request: Request,
    db: Session = Depends(get_db),
    admin: Usuario = Depends(exigir_admin),
):
    if db.query(Usuario).filter(Usuario.matricula == dados.matricula).first():
        raise HTTPException(409, "Matrícula já cadastrada.")
    if dados.supervisor_id is not None:
        if db.get(Usuario, dados.supervisor_id) is None:
            raise HTTPException(404, "Supervisor informado não existe.")

    # Coerência: papel administrador implica nível admin.
    nivel = dados.nivel_acesso
    if dados.papel == Papel.ADMINISTRADOR:
        nivel = NivelAcesso.ADMINISTRADOR

    usuario = Usuario(
        nome=dados.nome,
        matricula=dados.matricula,
        senha_hash=gerar_hash_senha(dados.senha),
        nivel_acesso=nivel,
        papel=dados.papel,
        organizacao=dados.organizacao,
        supervisor_id=dados.supervisor_id,
        unidade_setor=dados.unidade_setor,
        email=dados.email,
        ramal=dados.ramal,
        # Senha definida pelo admin é provisória: o usuário troca no 1º acesso.
        senha_provisoria=True,
    )
    db.add(usuario)
    db.flush()
    auditoria.registrar(
        db, usuario=admin, acao="usuario_criado", entidade="usuario",
        entidade_id=usuario.id, detalhe={"matricula": usuario.matricula},
        ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(usuario)
    return usuario


@router.put("/{usuario_id}", response_model=UsuarioResposta)
def atualizar(
    usuario_id: int,
    dados: UsuarioAtualizar,
    request: Request,
    db: Session = Depends(get_db),
    admin: Usuario = Depends(exigir_admin),
):
    usuario = db.get(Usuario, usuario_id)
    if usuario is None:
        raise HTTPException(404, "Usuário não encontrado.")

    revogar = False  # mudanças sensíveis invalidam sessões abertas

    if dados.nome is not None:
        usuario.nome = dados.nome
    if dados.unidade_setor is not None:
        usuario.unidade_setor = dados.unidade_setor
    if dados.email is not None:
        usuario.email = dados.email
    if dados.ramal is not None:
        usuario.ramal = dados.ramal

    if dados.supervisor_id is not None:
        if dados.supervisor_id == usuario_id:
            raise HTTPException(422, "Um usuário não pode supervisionar a si mesmo.")
        if db.get(Usuario, dados.supervisor_id) is None:
            raise HTTPException(404, "Supervisor informado não existe.")
        if _causaria_ciclo(db, usuario_id, dados.supervisor_id):
            raise HTTPException(422, "Essa hierarquia criaria um ciclo.")
        usuario.supervisor_id = dados.supervisor_id

    if dados.papel is not None and dados.papel != usuario.papel:
        usuario.papel = dados.papel
        if dados.papel == Papel.ADMINISTRADOR:
            usuario.nivel_acesso = NivelAcesso.ADMINISTRADOR
        revogar = True
    if dados.nivel_acesso is not None:
        usuario.nivel_acesso = dados.nivel_acesso
        revogar = True
    if dados.ativo is not None:
        usuario.ativo = 1 if dados.ativo else 0
        if not dados.ativo:
            revogar = True
    if dados.nova_senha is not None:
        usuario.senha_hash = gerar_hash_senha(dados.nova_senha)
        usuario.senha_provisoria = True  # força troca no próximo acesso
        revogar = True

    if revogar:
        usuario.token_version += 1  # invalida JWTs antigos imediatamente

    auditoria.registrar(
        db, usuario=admin, acao="usuario_atualizado", entidade="usuario",
        entidade_id=usuario.id, detalhe={"revogou_sessoes": revogar},
        ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(usuario)
    return usuario


def _tem_historico(db: Session, uid: int) -> bool:
    """True se o usuário aparece em chamados/comentários/anexos/auditoria/KB."""
    if db.query(Chamado.id).filter(or_(
        Chamado.autor_id == uid,
        Chamado.aberto_por_id == uid,
        Chamado.atribuido_a_id == uid,
    )).first():
        return True
    if db.query(Comentario.id).filter(Comentario.autor_id == uid).first():
        return True
    if db.query(Anexo.id).filter(Anexo.enviado_por_id == uid).first():
        return True
    if db.query(Auditoria.id).filter(Auditoria.usuario_id == uid).first():
        return True
    if db.query(Artigo.id).filter(Artigo.criado_por_id == uid).first():
        return True
    return False


@router.delete("/{usuario_id}")
def excluir(
    usuario_id: int,
    request: Request,
    db: Session = Depends(get_db),
    admin: Usuario = Depends(exigir_admin),
):
    """
    Exclui um usuário.
      - Sem histórico  -> apaga de verdade (hard delete).
      - Com histórico  -> ANONIMIZA e desativa (preserva a trilha/chamados).
    Protege contra apagar a si mesmo ou o último administrador ativo.
    """
    alvo = db.get(Usuario, usuario_id)
    if alvo is None:
        raise HTTPException(404, "Usuário não encontrado.")
    if alvo.id == admin.id:
        raise HTTPException(422, "Você não pode excluir o próprio usuário.")
    if alvo.nivel_acesso == NivelAcesso.ADMINISTRADOR:
        outros_admins = db.query(Usuario.id).filter(
            Usuario.nivel_acesso == NivelAcesso.ADMINISTRADOR,
            Usuario.id != alvo.id,
            Usuario.ativo == 1,
        ).first()
        if not outros_admins:
            raise HTTPException(422, "Não é possível excluir o último administrador.")

    # Subordinados "sobem" para o supervisor do excluído (evita órfãos/FK solta).
    db.query(Usuario).filter(Usuario.supervisor_id == alvo.id).update(
        {Usuario.supervisor_id: alvo.supervisor_id}, synchronize_session=False
    )
    # Linhas puramente pessoais podem ir embora nos dois caminhos.
    db.query(Notificacao).filter(Notificacao.usuario_id == alvo.id).delete(synchronize_session=False)
    db.query(ArtigoVoto).filter(ArtigoVoto.usuario_id == alvo.id).delete(synchronize_session=False)

    tinha_historico = _tem_historico(db, alvo.id)
    matricula = alvo.matricula

    if tinha_historico:
        # Anonimiza: mantém a linha (e as FKs), remove PII e bloqueia o acesso.
        alvo.nome = f"Usuário removido #{alvo.id}"
        alvo.matricula = f"removido_{alvo.id}"
        alvo.email = None
        alvo.ramal = None
        alvo.ativo = 0
        alvo.senha_hash = gerar_hash_senha(secrets.token_urlsafe(24))
        alvo.token_version += 1  # derruba sessões abertas
        acao = "anonimizado"
    else:
        db.delete(alvo)
        acao = "apagado"

    auditoria.registrar(
        db, usuario=admin, acao=f"usuario_{acao}", entidade="usuario",
        entidade_id=usuario_id, detalhe={"matricula": matricula},
        ip=ip_requisicao(request),
    )
    db.commit()
    return {
        "detail": (
            f"Usuário '{matricula}' apagado." if acao == "apagado"
            else f"Usuário '{matricula}' tinha histórico: foi anonimizado e desativado "
                 "(o histórico/chamados foram preservados)."
        ),
        "acao": acao,
    }


@router.get("/organograma")
def organograma(db: Session = Depends(get_db), _: Usuario = Depends(exigir_admin)):
    """Árvore hierárquica (lista achatada com parent_id para o front montar)."""
    usuarios = db.query(Usuario).filter(Usuario.ativo == 1).all()
    return [
        {
            "id": u.id,
            "nome": u.nome,
            "papel": u.papel.value,
            "supervisor_id": u.supervisor_id,
            "unidade_setor": u.unidade_setor,
        }
        for u in usuarios
    ]

"""
seed_usuarios.py — Popula APENAS os usuários (sem chamados, KB, taxonomia, etc.).

Uso:
    python seed_usuarios.py            # cria os usuários que faltarem (idempotente)
    python seed_usuarios.py --reset    # APAGA e recria o schema, depois cria os usuários

Mesma hierarquia e credenciais do seed principal, divididas nas duas marcas:
    - Bradesco BBI (vinho):  admin, carla.coord, lucas.lider, ana.analista, joao.silva
    - Ágora (verde):         bianca.agora (líder) → maria.souza, pedro.agora
"""
import sys

from app.database import Base, SessionLocal, engine
from app.models import NivelAcesso, Organizacao, Papel

# Reaproveita o helper do seed principal (idempotente: pula quem já existe).
# Importar seed.py é seguro: a execução fica sob `if __name__ == "__main__"`.
from seed import criar_usuario

BBI = Organizacao.BRADESCO_BBI
AGORA = Organizacao.AGORA


def criar_usuarios(db) -> None:
    print("Criando usuários...")

    # --- Bradesco BBI (esquema vinho) ---
    admin = criar_usuario(
        db, "Administrador do Suporte", "admin", "Admin@1234",
        NivelAcesso.ADMINISTRADOR, Papel.ADMINISTRADOR, setor="TI",
        email="admin@empresa.com", organizacao=BBI,
    )
    coord = criar_usuario(
        db, "Carla Coordenadora", "carla.coord", "Senha@1234",
        NivelAcesso.USUARIO, Papel.COORDENADOR, supervisor=admin,
        setor="TI", email="carla@empresa.com", organizacao=BBI,
    )
    lider = criar_usuario(
        db, "Lucas Líder", "lucas.lider", "Senha@1234",
        NivelAcesso.USUARIO, Papel.LIDER, supervisor=coord,
        setor="Suporte N1", email="lucas@empresa.com", organizacao=BBI,
    )
    criar_usuario(
        db, "Ana Analista", "ana.analista", "Senha@1234",
        NivelAcesso.USUARIO, Papel.ANALISTA, supervisor=lider,
        setor="Suporte N1", email="ana@empresa.com", organizacao=BBI,
    )
    criar_usuario(
        db, "João da Silva", "joao.silva", "Senha@1234",
        NivelAcesso.USUARIO, Papel.COLABORADOR, supervisor=lider,
        setor="Agência Central", email="joao@empresa.com", organizacao=BBI,
    )

    # --- Ágora Investimentos (esquema verde-petróleo) ---
    bianca = criar_usuario(
        db, "Bianca Líder (Ágora)", "bianca.agora", "Senha@1234",
        NivelAcesso.USUARIO, Papel.LIDER, supervisor=coord,
        setor="Ágora — Mesa", email="bianca@agorainvest.com.br", organizacao=AGORA,
    )
    criar_usuario(
        db, "Maria Souza", "maria.souza", "Senha@1234",
        NivelAcesso.USUARIO, Papel.COLABORADOR, supervisor=bianca,
        setor="Ágora — Filial Sul", email="maria@agorainvest.com.br", organizacao=AGORA,
    )
    criar_usuario(
        db, "Pedro Ágora", "pedro.agora", "Senha@1234",
        NivelAcesso.USUARIO, Papel.COLABORADOR, supervisor=bianca,
        setor="Ágora — Atendimento", email="pedro@agorainvest.com.br", organizacao=AGORA,
    )


def executar(reset: bool = False) -> None:
    if reset:
        print("Resetando schema (drop + create)...")
        Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        criar_usuarios(db)
    finally:
        db.close()

    print("\nUsuários prontos!")
    print("-" * 64)
    print("Credenciais:                                     | Organização")
    print("  ADMIN       -> admin        | Admin@1234        | Bradesco BBI")
    print("  COORDENADOR -> carla.coord  | Senha@1234        | Bradesco BBI")
    print("  LÍDER       -> lucas.lider  | Senha@1234        | Bradesco BBI")
    print("  ANALISTA    -> ana.analista | Senha@1234        | Bradesco BBI")
    print("  USUÁRIO     -> joao.silva   | Senha@1234        | Bradesco BBI")
    print("  LÍDER       -> bianca.agora | Senha@1234        | Ágora (verde)")
    print("  USUÁRIO     -> maria.souza  | Senha@1234        | Ágora (verde)")
    print("  USUÁRIO     -> pedro.agora  | Senha@1234        | Ágora (verde)")
    print("-" * 64)


if __name__ == "__main__":
    executar(reset="--reset" in sys.argv)

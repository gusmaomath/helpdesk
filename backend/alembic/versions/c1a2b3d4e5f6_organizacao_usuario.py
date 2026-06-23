"""organizacao do usuario (marca: bradesco_bbi / agora)

Revision ID: c1a2b3d4e5f6
Revises: a6202fd9f8c9
Create Date: 2026-06-23 15:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c1a2b3d4e5f6'
down_revision: Union[str, Sequence[str], None] = 'a6202fd9f8c9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Adiciona a coluna 'organizacao' (default bradesco_bbi para registros antigos)."""
    with op.batch_alter_table('usuarios', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                'organizacao',
                sa.Enum('BRADESCO_BBI', 'AGORA', name='organizacao'),
                nullable=False,
                server_default='BRADESCO_BBI',
            )
        )
        batch_op.create_index(
            batch_op.f('ix_usuarios_organizacao'), ['organizacao'], unique=False
        )


def downgrade() -> None:
    with op.batch_alter_table('usuarios', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_usuarios_organizacao'))
        batch_op.drop_column('organizacao')

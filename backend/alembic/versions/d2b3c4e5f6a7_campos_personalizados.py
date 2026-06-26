"""campos personalizados (chamado modular) em templates e chamados

Revision ID: d2b3c4e5f6a7
Revises: c1a2b3d4e5f6
Create Date: 2026-06-25 10:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd2b3c4e5f6a7'
down_revision: Union[str, Sequence[str], None] = 'c1a2b3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('templates', sa.Column('campos_personalizados', sa.JSON(), nullable=True))
    op.add_column('chamados', sa.Column('campos_personalizados', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('chamados', 'campos_personalizados')
    op.drop_column('templates', 'campos_personalizados')

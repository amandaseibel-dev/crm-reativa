-- Desfaz 20260902_agnes_nao_tem_dois_cadastros.sql: devolve o nome que estava no cadastro.
update alunos a
set nome = b.nome_antigo,
    nome_normalizado = b.nome_normalizado_antigo,
    nome_aluno = b.nome_aluno_antigo,
    nome_referencia = b.nome_referencia_antigo,
    updated_at = now()
from _backup_nome_trocado_20260902 b
where b.aluno_id = a.id
  and a.id = 'c0670833-093c-44c9-9068-895b78eb6680';

-- Desfaz tambem o lote das 17 linhas.
update alunos a
set nome = b.nome_antigo,
    nome_normalizado = b.nome_normalizado_antigo,
    nome_aluno = b.nome_aluno_antigo,
    nome_referencia = b.nome_referencia_antigo,
    updated_at = now()
from _backup_nome_trocado_20260902 b
where b.aluno_id = a.id and b.motivo like 'lote 02/09%';

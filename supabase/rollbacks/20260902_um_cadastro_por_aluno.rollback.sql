-- Desfaz 20260902_um_cadastro_por_aluno.sql. Ordem inversa: C, B, A.

-- (C) Andrigo: devolve a linha removida e repoe os vinculos nela.
insert into alunos select * from jsonb_populate_record(null::alunos,
  (select linha from _backup_merge_andrigo_20260902 where papel='linha_removida'))
on conflict (id) do nothing;
update acordos_titulos set aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9'
where id = '99e746b9-75c5-47c0-a556-1ee4f1fc59bd';
update alunos set email = (select linha->>'email' from _backup_merge_andrigo_20260902 where papel='linha_mantida')
where id = 'd13b6a16-cb50-44b6-82d7-fb7f3d415fe8';

-- (B) cascas: recria as 17 linhas e devolve os vinculos que foram repontados.
insert into alunos
select (jsonb_populate_record(null::alunos, linha)).* from _backup_casca_sem_cpf_20260902
on conflict (id) do nothing;
-- Atencao: o repontamento de (B) nao guarda o id de cada linha movida. Para desfazer por
-- completo, restaurar as tabelas de vinculo do backup do banco do dia 02/09/2026.

-- (A) 8 casos invertidos: devolve o nome que estava no caso.
update casos c
set nome = b.nome_antigo, nome_normalizado = b.nome_normalizado_antigo,
    nome_aluno = b.nome_aluno_antigo, nome_referencia = b.nome_referencia_antigo
from _backup_caso_nome_trocado_20260902 b where b.caso_id = c.id;

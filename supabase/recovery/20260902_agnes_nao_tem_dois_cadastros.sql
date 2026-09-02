-- 02/09/2026 — "Agnes Cibele Dal'Toé" aparecia duas vezes na varredura de duplicidade.
-- Nao era duplicidade: a segunda linha e de OUTRA pessoa (Aliny Angelica Alves,
-- CPF 043.171.691-93, matricula Prime 151018447, R$ 1.323,00 com a Luana).
-- So o campo nome do cadastro estava com o nome da Agnes; CPF, e-mail, telefone e
-- titulos sempre foram da Aliny. O caso 14085 ja trazia o nome certo.
-- Nada foi apagado: o cadastro passou a se chamar pelo dono real, e sobra uma unica Agnes.

create table if not exists _backup_nome_trocado_20260902 (
  aluno_id uuid,
  nome_antigo text, nome_normalizado_antigo text, nome_aluno_antigo text, nome_referencia_antigo text,
  nome_novo text, cpf text, motivo text, feito_em timestamptz default now()
);
alter table _backup_nome_trocado_20260902 enable row level security;

insert into _backup_nome_trocado_20260902
  (aluno_id, nome_antigo, nome_normalizado_antigo, nome_aluno_antigo, nome_referencia_antigo, nome_novo, cpf, motivo)
select a.id, a.nome, a.nome_normalizado, a.nome_aluno, a.nome_referencia, c.nome, a.cpf,
       'cadastro exibia o nome de outra pessoa; nome correto veio do caso ' || c.caso_codigo
from alunos a join casos c on c.aluno_id = a.id
where a.id = 'c0670833-093c-44c9-9068-895b78eb6680';

update alunos a
set nome = c.nome,
    nome_aluno = c.nome,
    nome_normalizado = lower(unaccent(c.nome)),
    nome_referencia = upper(c.nome),
    updated_at = now()
from casos c
where c.aluno_id = a.id and a.id = 'c0670833-093c-44c9-9068-895b78eb6680';

-- ---------------------------------------------------------------------------
-- Lote (02/09/2026): mesmo defeito em outros cadastros.
-- Regra de decisao: so corrige quando o E-MAIL da linha corrobora o nome do CASO
-- (token de 4+ letras do nome do caso aparece no e-mail) E nao corrobora o nome
-- do cadastro. Foram 17 linhas. As demais NAO foram tocadas:
--   8 estao invertidas (o e-mail confirma o nome do CADASTRO, entao quem esta
--     errado e o casos.nome) e 7 nao dao para corroborar (4 sem e-mail,
--     3 com e-mail que nao bate com nenhum dos dois lados).
insert into _backup_nome_trocado_20260902
  (aluno_id, nome_antigo, nome_normalizado_antigo, nome_aluno_antigo, nome_referencia_antigo, nome_novo, cpf, motivo)
select a.id, a.nome, a.nome_normalizado, a.nome_aluno, a.nome_referencia, c.nome, a.cpf,
       'lote 02/09: e-mail confirma o nome do caso ' || c.caso_codigo
from casos c join alunos a on a.id = c.aluno_id
where a.cpf = c.cpf_limpo
  and upper(unaccent(a.nome)) <> upper(unaccent(c.nome))
  and left(upper(unaccent(a.nome)),4) <> left(upper(unaccent(c.nome)),4)
  and (select count(*) from unnest(string_to_array(lower(unaccent(c.nome)),' ')) t
        where length(t) >= 4 and position(t in lower(coalesce(a.email,''))) > 0) > 0
  and (select count(*) from unnest(string_to_array(lower(unaccent(a.nome)),' ')) t
        where length(t) >= 4 and position(t in lower(coalesce(a.email,''))) > 0) = 0;

update alunos a
set nome = c.nome,
    nome_aluno = c.nome,
    nome_normalizado = lower(unaccent(c.nome)),
    nome_referencia = upper(c.nome),
    updated_at = now()
from casos c
where c.aluno_id = a.id
  and a.id in (select aluno_id from _backup_nome_trocado_20260902 where motivo like 'lote 02/09%')
  and upper(unaccent(a.nome)) <> upper(unaccent(c.nome));

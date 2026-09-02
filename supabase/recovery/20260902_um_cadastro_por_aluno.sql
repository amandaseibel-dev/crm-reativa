-- 02/09/2026 — "precisa ficar sempre um cadastro por aluno".
-- Regra aplicada: um cadastro por PESSOA (por CPF), nao por nome. Xara nao e duplicata:
-- ver [[cadastro-com-nome-de-outra-pessoa]] / caso Agnes x Aliny.
-- Executado em prod nesta ordem. Backups: _backup_caso_nome_trocado_20260902,
-- _backup_casca_sem_cpf_20260902, _backup_merge_andrigo_20260902, _mapa_casca_20260902.

-- (A) 8 casos "invertidos": o e-mail do cadastro confirma o nome DELE, entao quem estava
--     errado era casos.nome. Espelho do lote que corrigiu alunos.nome.
create table if not exists _backup_caso_nome_trocado_20260902 (
  caso_id uuid, caso_codigo bigint, aluno_id uuid,
  nome_antigo text, nome_normalizado_antigo text, nome_aluno_antigo text, nome_referencia_antigo text,
  nome_novo text, cpf text, motivo text, feito_em timestamptz default now()
);
alter table _backup_caso_nome_trocado_20260902 enable row level security;

with alvo as (
  select c.id caso_id, c.caso_codigo, a.id aluno_id, c.nome nome_caso, a.nome nome_cadastro, a.cpf,
         c.nome_normalizado, c.nome_aluno, c.nome_referencia
  from casos c join alunos a on a.id = c.aluno_id
  where a.cpf = c.cpf_limpo
    and upper(unaccent(a.nome)) <> upper(unaccent(c.nome))
    and left(upper(unaccent(a.nome)),4) <> left(upper(unaccent(c.nome)),4)
    and a.email is not null
    and (select count(*) from unnest(string_to_array(lower(unaccent(a.nome)),' ')) t
          where length(t)>=4 and position(t in lower(a.email))>0) > 0
    and (select count(*) from unnest(string_to_array(lower(unaccent(c.nome)),' ')) t
          where length(t)>=4 and position(t in lower(a.email))>0) = 0
), b as (
  insert into _backup_caso_nome_trocado_20260902
    (caso_id, caso_codigo, aluno_id, nome_antigo, nome_normalizado_antigo, nome_aluno_antigo,
     nome_referencia_antigo, nome_novo, cpf, motivo)
  select caso_id, caso_codigo, aluno_id, nome_caso, nome_normalizado, nome_aluno, nome_referencia,
         nome_cadastro, cpf, 'invertido: e-mail confirma o nome do cadastro'
  from alvo returning caso_id
)
update casos c
set nome = alvo.nome_cadastro, nome_aluno = alvo.nome_cadastro,
    nome_normalizado = upper(unaccent(alvo.nome_cadastro)),
    nome_referencia = upper(alvo.nome_cadastro),
    caso_atualizado_por = 'amanda.seibel@aelbra.com.br', caso_atualizado_em = now()
from alvo where alvo.caso_id = c.id and c.id in (select caso_id from b);

-- (B) 17 "cascas": linha sem CPF, saldo zero, sem caso/titulo/acordo, gemea unica com CPF e mesmo
--     nome. NAO estavam vazias de verdade (uma segurava um pagamento de R$ 8.598,15), entao
--     PRIMEIRO repontar tudo para a gemea, so depois apagar.
create table if not exists _backup_casca_sem_cpf_20260902 (
  casca_id uuid, gemea_id uuid, nome text, linha jsonb, refs_movidas jsonb, feito_em timestamptz default now()
);
alter table _backup_casca_sem_cpf_20260902 enable row level security;

create table if not exists _mapa_casca_20260902 as
select a.id casca_id,
       (select t.id from alunos t where lower(unaccent(t.nome))=lower(unaccent(a.nome)) and t.cpf is not null limit 1) gemea_id,
       a.nome
from alunos a
where a.cpf is null
  and exists (select 1 from alunos t where lower(unaccent(t.nome))=lower(unaccent(a.nome)) and t.cpf is not null);

insert into _backup_casca_sem_cpf_20260902 (casca_id, gemea_id, nome, linha, refs_movidas)
select m.casca_id, m.gemea_id, m.nome, to_jsonb(a.*), '{}'::jsonb
from _mapa_casca_20260902 m join alunos a on a.id = m.casca_id;

update aluno_movimentacoes x set aluno_id = m.gemea_id::text from _mapa_casca_20260902 m where x.aluno_id::text = m.casca_id::text;
update fila_conferencia_dados x set aluno_id = m.gemea_id from _mapa_casca_20260902 m where x.aluno_id = m.casca_id;
update pagamentos x set aluno_id = m.gemea_id from _mapa_casca_20260902 m where x.aluno_id = m.casca_id;
update solicitacoes_confirmacao_pagamento x set aluno_id = m.gemea_id::text from _mapa_casca_20260902 m where x.aluno_id = m.casca_id::text;
update saldo_zero_confirmado_auditoria x set aluno_id = m.gemea_id from _mapa_casca_20260902 m where x.aluno_id = m.casca_id;
update acoes_desfazer x set aluno_id = m.gemea_id from _mapa_casca_20260902 m where x.aluno_id = m.casca_id;
update acordo_reconstruir x set aluno_id = m.gemea_id from _mapa_casca_20260902 m where x.aluno_id = m.casca_id;
update notificacoes x set aluno_id = m.gemea_id::text from _mapa_casca_20260902 m where x.aluno_id = m.casca_id::text;
update documento_mapa x set aluno_id = m.gemea_id from _mapa_casca_20260902 m where x.aluno_id = m.casca_id;
update conciliacao_pagamento_conferido x set aluno_id = m.gemea_id from _mapa_casca_20260902 m where x.aluno_id = m.casca_id;

delete from alunos a using _mapa_casca_20260902 m where a.id = m.casca_id;

-- (C) Andrigo do Prado Stafin: MESMO nome e MESMO CPF em duas linhas. Unica duplicata de
--     verdade da base. Mantida a linha antiga (que tem o caso e o acordo).
create table if not exists _backup_merge_andrigo_20260902 as
select 'linha_removida' papel, to_jsonb(a.*) linha, now() feito_em from alunos a where a.id = '2c57a9a0-cff2-46a2-a940-90a6266a17e9'
union all
select 'linha_mantida', to_jsonb(a.*), now() from alunos a where a.id = 'd13b6a16-cb50-44b6-82d7-fb7f3d415fe8';
alter table _backup_merge_andrigo_20260902 enable row level security;

update notificacoes set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8' where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update conciliacao_santander_decisao set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8'::uuid where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update conciliacao_pagamento_conferido set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8'::uuid where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update pagamentos set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8'::uuid where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update aluno_movimentacoes set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8' where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update acordos_titulos set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8'::uuid where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update baixas_pagamento set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8' where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update acordo_reconstruir set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8'::uuid where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update documento_mapa set aluno_id='d13b6a16-cb50-44b6-82d7-fb7f3d415fe8'::uuid where aluno_id='2c57a9a0-cff2-46a2-a940-90a6266a17e9';
update alunos set email = coalesce(email,'dstafin55@gmail.com'), updated_at = now() where id = 'd13b6a16-cb50-44b6-82d7-fb7f3d415fe8';
delete from alunos where id = '2c57a9a0-cff2-46a2-a940-90a6266a17e9';

-- NAO TOCADO de proposito:
--   112 nomes repetidos com CPFs DIFERENTES (243 linhas, R$ 511.638,18). Sao pessoas distintas
--     ou nome trocado — nunca duplicata. Unir por nome apagaria divida de gente de verdade.
--   2 CPFs que aparecem em duas linhas com nomes DIFERENTES (035.352.170-16 Thais x Ana Bella;
--     062.451.590-75 Luiz Ricardo x Marco Antonio): um dos dois esta com o CPF errado.
--     So o Prime resolve.

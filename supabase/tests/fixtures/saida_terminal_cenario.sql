-- CENÁRIO DA SAÍDA TERMINAL (Etapa 1 da conciliação inteligente)
-- -----------------------------------------------------------------------------
-- Complemento de `fluxo_incremental_prod_20261021.sql` +
-- `importacao_conferencia_cenario.sql`. Aqui entra só o que falta: a
-- `internal.patch_funcao_ancorada`, a `auditoria` com a FORMA de produção, e
-- oito pagamentos que cobrem o caminho feliz e as seis recusas.
--
-- O QUE ESTE CENÁRIO NÃO PROVA: que produção tem estes números. As medições de
-- 24/10/2026 estão no cabeçalho da migration e em
-- docs/CONCILIACAO-INTELIGENTE-2026-10-24.md, com as consultas.

-- -----------------------------------------------------------------------------
-- `auditoria` COM A FORMA DE PRODUÇÃO
-- -----------------------------------------------------------------------------
-- A bancada base traz `registro_id text`, `id bigserial` e `criado_em`.
-- Produção tem `registro_id uuid`, `id uuid` e `created_at` (conferido em
-- 24/10/2026 em information_schema). A função compara `registro_id` com um
-- uuid: se o teste rodasse sobre a forma da bancada, ele provaria um
-- `text = uuid` que NÃO é o que produção executa. Então a tabela é recriada com
-- a forma real -- nada foi inserido nela até aqui.
drop table if exists public.auditoria;
create table public.auditoria (
  id uuid primary key default gen_random_uuid(),
  usuario text,
  acao text,
  tabela_afetada text,
  registro_id uuid,
  detalhes jsonb,
  created_at timestamp without time zone default now()
);

-- -----------------------------------------------------------------------------
-- `internal.patch_funcao_ancorada`, como está em produção
-- -----------------------------------------------------------------------------
create schema if not exists internal;

create or replace function internal.patch_funcao_ancorada(
  p_schema text, p_funcao text, p_ancora text, p_novo text, p_ocorrencias integer)
returns void
language plpgsql
as $function$
declare v_src text; v_n int; v_ja int;
begin
  if position(p_novo in p_ancora) > 0 and position(p_ancora in p_novo) = 0 then
    raise exception 'patch_funcao_ancorada: o texto novo e pedaco da ancora — patch ambiguo, reescreva a ancora.';
  end if;

  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = p_schema and p.proname = p_funcao
   limit 1;

  if v_src is null then
    raise exception 'patch_funcao_ancorada: %.% nao existe.', p_schema, p_funcao;
  end if;

  v_ja := (length(v_src) - length(replace(v_src, p_novo, ''))) / length(p_novo);
  if v_ja >= p_ocorrencias then
    raise notice 'patch_funcao_ancorada: %.% ja estava aplicada.', p_schema, p_funcao;
    return;
  end if;

  v_n := (length(v_src) - length(replace(v_src, p_ancora, ''))) / length(p_ancora);
  if v_n <> p_ocorrencias then
    raise exception 'patch_funcao_ancorada: %.% tem % ocorrencia(s) da ancora, esperado %. A funcao mudou; revise o patch.',
      p_schema, p_funcao, v_n, p_ocorrencias;
  end if;

  execute replace(v_src, p_ancora, p_novo);
end;
$function$;

-- -----------------------------------------------------------------------------
-- OS OITO PAGAMENTOS
-- -----------------------------------------------------------------------------
-- Valores na casa dos milhares para não colidirem com os do cenário da #746
-- (100..700): assim qualquer soma por categoria continua verificável.
--
--   T1  elegível, decisão FEITO                      -> CONFIRMADO
--   T2  elegível, decisão ENCERRADO_GESTAO           -> CONFIRMADO
--   T3  decisão RESOLVIDO_AUTOMATICO SEM auditoria   -> SEM_PROVA_DE_DECISAO_SEM_EFEITO
--   T4  decidido, COM parcela apontando              -> TEM_BAIXA_REGISTRADA
--   T5  fila ABERTA (decisao nula), com auditoria    -> SEM_DECISAO_VALIDA
--   T6  decisão fora da allowlist                    -> DECISAO_FORA_DA_ALLOWLIST
--   T7  status nulo (pré-14/09), decidido e auditado -> FORA_DA_JANELA
--   T8  BAIXADO, decidido e auditado                 -> JA_BAIXADO
insert into public.pagamentos
  (id, importacao_id, data_pagamento, valor_pago, valor_honorario, aluno_nome, matricula,
   titulo_numero, numero_parcela_completo, operador_nome, status_conciliacao, conciliacao_motivo, created_at)
values
  ('ee000001-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '2026-09-20', 1000, 100, 'TERMINAL UM', '2026001001', '60001', '60001510001', 'MARIA',
   'REVISAO', 'parcela ja estava PAGO antes', now()),
  ('ee000002-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '2026-09-20', 2000, 200, 'TERMINAL DOIS', '2026001002', '60002', '60002510001', 'MARIA',
   'AGUARDANDO_ACORDO', 'o acordo nao esta no CRM', now()),
  ('ee000003-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '2026-09-20', 3000, 300, 'TERMINAL TRES', '2026001003', '60003', '60003510001', 'JOAO',
   'REVISAO', 'parcela ja estava PAGO antes', now()),
  ('ee000004-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '2026-09-20', 4000, 400, 'TERMINAL QUATRO', '2026001004', '60004', '60004510001', 'JOAO',
   'REVISAO', 'parcela ja estava PAGO antes', now()),
  ('ee000005-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '2026-09-20', 5000, 500, 'TERMINAL CINCO', '2026001005', '60005', '60005510001', 'LUANA',
   'REVISAO', 'o acordo nao tem parcela livre', now()),
  ('ee000006-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '2026-09-20', 6000, 600, 'TERMINAL SEIS', '2026001006', '60006', '60006510001', 'LUANA',
   'REVISAO', 'o acordo nao tem parcela livre', now()),
  ('ee000007-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '2026-08-20', 7000, 700, 'TERMINAL SETE', '2026001007', '60007', '60007510001', 'DIEGO',
   null, null, now()),
  ('ee000008-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-00000000000a',
   '2026-09-20', 8000, 800, 'TERMINAL OITO', '2026001008', '60008', '60008510001', 'DIEGO',
   'BAIXADO', null, now())
on conflict (id) do nothing;

-- A parcela de T4: ela é o que faz a recusa TEM_BAIXA_REGISTRADA existir.
insert into public.parcelas
  (id, acordo_id, numero, valor, vencimento, status, origem_baixa, origem_baixa_ref, origem_baixa_em)
values
  ('ee0f0004-0000-0000-0000-000000000004', null, 1, 4000, '2026-09-10', 'PAGO',
   'GATILHO_IMPORTACAO', 'ee000004-0000-0000-0000-000000000004', '2026-09-20 10:00:00'),
  -- T8 e BAIXADO, e em producao TODO BAIXADO tem parcela apontando (medido:
  -- 1.333 pagamentos, 1.333 refs distintas). Sem esta parcela ele cairia em
  -- NAO_CLASSIFICADO na conferencia por arquivo -- residuo da bancada, nao da
  -- view. A recusa JA_BAIXADO continua sendo a dele: o status e conferido
  -- ANTES da parcela.
  ('ee0f0008-0000-0000-0000-000000000008', null, 1, 8000, '2026-09-10', 'PAGO',
   'GATILHO_IMPORTACAO', 'ee000008-0000-0000-0000-000000000008', '2026-09-20 10:00:00')
on conflict (id) do nothing;

-- AS LINHAS DA FILA. Só T5 fica ABERTA (decisao nula).
insert into public.fila_pagamento_sem_vinculo
  (id, pagamento_id, importacao_id, arquivo_nome, boleto, data_pagamento, valor_pago,
   motivo, sugestoes, decisao, conclusao, decidido_por, decidido_em,
   consulta_portador_em, detectado_em)
values
  (101, 'ee000001-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'arquivo-A.xlsx', '60001510001', '2026-09-20', 1000,
   'a parcela ja estava PAGO antes da extracao', '[]'::jsonb,
   'FEITO', 'PARCELA_JA_PAGA_CONFERIDA', 'amanda.seibel@aelbra.com.br',
   '2026-09-29 10:00:00', now(), now()),
  (102, 'ee000002-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'arquivo-A.xlsx', '60002510001', '2026-09-20', 2000,
   'o acordo nao esta no CRM', '[]'::jsonb,
   'ENCERRADO_GESTAO', null, 'amanda.seibel@aelbra.com.br',
   '2026-09-18 10:00:00', now(), now()),
  (103, 'ee000003-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'arquivo-A.xlsx', '60003510001', '2026-09-20', 3000,
   'a parcela ja estava PAGO antes da extracao', '[]'::jsonb,
   'RESOLVIDO_AUTOMATICO', null, 'conciliacao@sistema',
   '2026-09-17 10:00:00', now(), now()),
  (104, 'ee000004-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'arquivo-A.xlsx', '60004510001', '2026-09-20', 4000,
   'a parcela ja estava PAGO antes da extracao', '[]'::jsonb,
   'RESOLVIDO_AUTOMATICO', null, 'conciliacao@sistema',
   '2026-09-17 10:00:00', now(), now()),
  -- T5: ABERTA. A auditoria dela existe de propósito -- a prova (c) sozinha não
  -- pode abrir a porta sem a (a).
  (105, 'ee000005-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'arquivo-A.xlsx', '60005510001', '2026-09-20', 5000,
   'o acordo nao tem parcela livre', '[]'::jsonb,
   null, null, null, null, now(), now()),
  -- T6: decisão que NÃO está na allowlist. Hoje não existe em produção; é o
  -- cenário do dia em que alguém criar um valor novo que signifique
  -- "reprocessar". `decisao is not null` deixaria passar.
  (106, 'ee000006-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'arquivo-A.xlsx', '60006510001', '2026-09-20', 6000,
   'o acordo nao tem parcela livre', '[]'::jsonb,
   'REPROCESSAR', null, 'alguem@aelbra.com.br',
   '2026-10-01 10:00:00', now(), now()),
  (107, 'ee000007-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'arquivo-A.xlsx', '60007510001', '2026-08-20', 7000,
   'pagamento anterior ao motor', '[]'::jsonb,
   'ENCERRADO_GESTAO', null, 'amanda.seibel@aelbra.com.br',
   '2026-09-18 10:00:00', now(), now()),
  (108, 'ee000008-0000-0000-0000-000000000008', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'arquivo-A.xlsx', '60008510001', '2026-09-20', 8000,
   'baixado pelo relatorio', '[]'::jsonb,
   'FEITO', 'OUTRO_CONFIRMADO', 'amanda.seibel@aelbra.com.br',
   '2026-09-29 10:00:00', now(), now())
on conflict (id) do nothing;

-- A PROCEDÊNCIA. Todos menos T3: é ele que reproduz o único dos 33 que não tem
-- auditoria nenhuma, e que a função RECUSA de propósito.
insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
select 'amanda.seibel@aelbra.com.br', 'CONCILIACAO_FEITO_PELA_GESTAO',
       'fila_pagamento_sem_vinculo', f.pagamento_id,
       jsonb_build_object('pagamento_id', f.pagamento_id, 'decisao', f.decisao,
                          'sem_efeito_financeiro', true)
  from public.fila_pagamento_sem_vinculo f
 where f.id in (101, 102, 104, 105, 106, 107, 108);

-- RUÍDO DE PROPÓSITO: T3 tem auditoria de OUTRA tabela e de OUTRO pagamento.
-- Se a prova (c) não casasse `registro_id` e `tabela_afetada`, ele passaria.
insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
values
  ('alguem@aelbra.com.br', 'OUTRA_COISA', 'pagamentos',
   'ee000003-0000-0000-0000-000000000003',
   jsonb_build_object('sem_efeito_financeiro', true)),
  ('alguem@aelbra.com.br', 'CONCILIACAO_FEITO_PELA_GESTAO', 'fila_pagamento_sem_vinculo',
   'ee000001-0000-0000-0000-000000000001',
   jsonb_build_object('sem_efeito_financeiro', false));

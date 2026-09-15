-- A UNICA PORTA DE ENTRADA DA STAGE PASSA A SER UMA RPC.
--
-- POR QUE. O smoke sintetico em producao, 15/09/2026, reprovou com 42501:
--
--   parsed.application_name = PostgREST 14.5
--   parsed.command_tag      = SELECT
--   parsed.hint             = GRANT SELECT ON public.backfill_matricula_stage
--                             TO service_role;
--   parsed.query            = WITH pgrst_source AS (INSERT INTO
--                             "public"."backfill_matricula_stage"(...) SELECT ...
--
-- O PostgREST envolve TODO insert num CTE e faz SELECT dele -- o command tag e
-- literalmente `SELECT`. Entao gravar pela tabela exigiria `SELECT` na tabela,
-- e `Prefer: return=minimal` nao muda isso: e a forma da query que ele monta,
-- nao o cabecalho. Tirar `count: "exact"` foi necessario e NAO foi suficiente.
--
-- Conceder SELECT resolveria em uma linha e daria ao backend leitura do plano
-- inteiro -- 7.401 matriculas de pessoas reais. Nao e o que se quer.
--
-- ENTAO A PORTA MUDA: a Edge deixa de falar com a tabela e passa a chamar esta
-- funcao. Ela e `SECURITY DEFINER` do `postgres`, entao insere sem que
-- `service_role` tenha privilegio nenhum na tabela. O caminho vira
--
--   Edge -> backfill_matricula_stage_carregar -> stage
--
-- e nao mais `Edge -> stage`.
--
-- POR QUE `SECURITY DEFINER` AQUI, SE O MOTOR E `INVOKER`. Sao papeis
-- diferentes. O motor escreve em `pagamentos` -- tabela de dinheiro -- e por
-- isso nao pode rodar com privilegio do dono ao lado de um PostgREST publico.
-- Esta funcao escreve em UMA tabela isolada, de passagem, que nenhuma tela
-- alcanca; e `DEFINER` e justamente o que permite manter `service_role` SEM
-- privilegio algum sobre ela. O privilegio fica na funcao, com gate.
--
-- NOTA DE GOVERNANCA. A 20260915140000 concedeu `INSERT` na stage a
-- `service_role`, e a prova dela exige esse INSERT. Esta migration REVOGA esse
-- INSERT. As duas convivem porque migration ja aplicada nao roda de novo -- mas
-- fica registrado: quem reconstruir o banco do zero vera a 140000 conceder e
-- esta, logo depois, revogar. A ordem preserva o resultado.
--
-- O QUE ELA NAO FAZ: nao toca em `pagamentos`, nem em `backfill_matricula_lotes`
-- ou `_origem`, nao chama `backfill_matricula_aplicar`, nao religa
-- `consulta_portador` e nao usa nada da 20260915120000.

-- ---------------------------------------------------------------------------
-- 1. A RPC DE CARGA
-- ---------------------------------------------------------------------------

create or replace function public.backfill_matricula_stage_carregar(
  p_lote      text,
  p_registros jsonb
)
 returns jsonb
 language plpgsql
 security definer
 -- `pg_temp` por ultimo: sem isso, um objeto plantado no schema temporario do
 -- chamador poderia sequestrar uma referencia nao qualificada.
 set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_papel text;
  v_n     integer;
begin
  -- GATE. `SECURITY DEFINER` troca o `current_user` para o dono, entao ele nao
  -- serve para identificar quem chamou. O que sobrevive e o GUC `role`, que o
  -- PostgREST posiciona com `SET LOCAL ROLE` a partir do JWT -- medido em
  -- 15/09/2026: dentro da funcao, `current_user` = postgres e
  -- `current_setting('role')` = service_role.
  --
  -- Chamada direta pelo dono tem `role` = 'none' e e barrada de proposito:
  -- esta funcao existe para a Edge, e so.
  v_papel := coalesce(current_setting('role', true), '');
  if v_papel <> 'service_role' then
    raise exception 'backfill_matricula_stage_carregar e exclusiva de service_role; role = %',
      coalesce(nullif(v_papel, ''), '(vazio)') using errcode = '42501';
  end if;

  if p_lote is null or btrim(p_lote) = '' then
    raise exception 'lote obrigatorio';
  end if;
  if p_registros is null or jsonb_typeof(p_registros) <> 'array' then
    raise exception 'registros tem de ser um array jsonb';
  end if;

  v_n := jsonb_array_length(p_registros);
  if v_n = 0 then
    raise exception 'nenhum registro recebido';
  end if;
  -- Teto por chamada. O caller usa 100; 100 e o teto, nao a folga: manter a
  -- chamada minuscula e o que garante que ela nunca se aproxime dos 10 s do
  -- `auto_explain`, que loga parametros por inteiro e nao pode ser desligado
  -- por nao-superusuario.
  if v_n > 100 then
    raise exception 'no maximo 100 registros por chamada, recebidos %', v_n;
  end if;

  -- FORMA DE CADA ITEM. O payload nunca vira SQL: os campos sao extraidos por
  -- nome e passados como valores. Nao ha `execute` em lugar nenhum desta
  -- funcao.
  if exists (
    select 1 from jsonb_array_elements(p_registros) r
     where jsonb_typeof(r) <> 'object'
        or (select count(*) from jsonb_object_keys(r)) <> 5
        or not (r ? 'pagamento_id' and r ? 'numero_parcela_completo'
                and r ? 'matricula' and r ? 'arquivo_origem' and r ? 'linha_no_arquivo')
  ) then
    raise exception 'cada registro tem de ter exatamente os cinco campos esperados';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_registros) r
     where coalesce(btrim(r->>'pagamento_id'), '') = ''
        or coalesce(btrim(r->>'numero_parcela_completo'), '') = ''
        or coalesce(btrim(r->>'matricula'), '') = ''
        or coalesce(btrim(r->>'arquivo_origem'), '') = ''
        or r->>'linha_no_arquivo' is null
  ) then
    raise exception 'registro com campo obrigatorio vazio';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_registros) r
     where r->>'pagamento_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'pagamento_id fora do formato uuid';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_registros) r
     where jsonb_typeof(r->'linha_no_arquivo') <> 'number'
        or (r->>'linha_no_arquivo') !~ '^[0-9]+$'
        or (r->>'linha_no_arquivo')::bigint < 1
        or (r->>'linha_no_arquivo')::bigint > 2147483647
  ) then
    raise exception 'linha_no_arquivo tem de ser inteiro positivo';
  end if;

  -- DEPOSITO. `DO NOTHING`, nunca `DO UPDATE`: reenviar um pedaco e inofensivo,
  -- e uma linha ja carregada NUNCA e sobrescrita -- nem que o conteudo venha
  -- diferente. Quem manda no que sera aplicado e o hash da stage, conferido
  -- pelo motor.
  insert into public.backfill_matricula_stage
         (lote, pagamento_id, numero_parcela_completo, matricula, arquivo_origem, linha_no_arquivo)
  select p_lote,
         (r->>'pagamento_id')::uuid,
         r->>'numero_parcela_completo',
         r->>'matricula',
         r->>'arquivo_origem',
         (r->>'linha_no_arquivo')::integer
    from jsonb_array_elements(p_registros) r
      on conflict (lote, pagamento_id) do nothing;

  -- SO METADADO. Nenhuma linha da stage volta, nenhum dado pessoal.
  return jsonb_build_object('lote', p_lote, 'recebidos', v_n);
end;
$fn$;

comment on function public.backfill_matricula_stage_carregar(text, jsonb) is
  'Unica porta de entrada da stage de backfill. SECURITY DEFINER porque o PostgREST monta todo INSERT como CTE+SELECT, o que exigiria SELECT na tabela -- e service_role nao deve ler o plano. Gate por current_setting(role) = service_role. Insere com ON CONFLICT DO NOTHING e devolve so contagem.';

-- ---------------------------------------------------------------------------
-- 2. ACL: a porta fecha na tabela e abre so na funcao
-- ---------------------------------------------------------------------------

-- `PUBLIC` tem EXECUTE por padrao em toda funcao nova. Sem este revoke, o grant
-- abaixo nao restringe nada -- foi medido.
revoke all on function public.backfill_matricula_stage_carregar(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.backfill_matricula_stage_carregar(text, jsonb)
  to service_role;

-- E a tabela fecha: `service_role` perde o INSERT direto concedido pela
-- 20260915140000. A partir daqui ele nao tem privilegio ALGUM sobre a stage.
revoke all on table public.backfill_matricula_stage from service_role;

-- ---------------------------------------------------------------------------
-- 3. PROVA
-- ---------------------------------------------------------------------------

do $prova$
declare v_src text; v_codigo text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='backfill_matricula_stage_carregar';
  if v_src is null then
    raise exception 'a rpc de carga nao foi criada';
  end if;
  v_codigo := regexp_replace(v_src, '--[^\n]*', '', 'g');

  -- DEFINER, e com search_path fixo
  if not (select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='backfill_matricula_stage_carregar') then
    raise exception 'a rpc de carga nao ficou SECURITY DEFINER';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='backfill_matricula_stage_carregar'
                    and array_to_string(p.proconfig,',') like '%search_path=public, pg_temp%') then
    raise exception 'a rpc de carga ficou sem search_path fixo';
  end if;
  if pg_get_userbyid((select proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='backfill_matricula_stage_carregar'))
     <> 'postgres' then
    raise exception 'a rpc de carga nao pertence a postgres';
  end if;

  -- nada de SQL dinamico, e nada fora da stage
  if v_codigo ~* '\mexecute\M' then
    raise exception 'a rpc de carga ganhou SQL dinamico';
  end if;
  if v_codigo like '%public.pagamentos%'
  or v_codigo like '%backfill_matricula_lotes%'
  or v_codigo like '%backfill_matricula_origem%'
  or v_codigo like '%backfill_matricula_aplicar%' then
    raise exception 'a rpc de carga alcanca objeto que nao devia';
  end if;
  if v_codigo not like '%on conflict (lote, pagamento_id) do nothing%' then
    raise exception 'a rpc de carga perdeu o ON CONFLICT DO NOTHING';
  end if;
  if v_codigo ~* 'do\s+update' then
    raise exception 'a rpc de carga ganhou DO UPDATE';
  end if;
  if v_codigo not like '%current_setting(''role'', true)%' then
    raise exception 'a rpc de carga perdeu o gate de papel';
  end if;

  -- ACL da funcao
  if has_function_privilege('anon',
       'public.backfill_matricula_stage_carregar(text, jsonb)', 'EXECUTE')
  or has_function_privilege('authenticated',
       'public.backfill_matricula_stage_carregar(text, jsonb)', 'EXECUTE')
  or has_function_privilege('public',
       'public.backfill_matricula_stage_carregar(text, jsonb)', 'EXECUTE') then
    raise exception 'a rpc de carga ficou executavel por public, anon ou authenticated';
  end if;
  if not has_function_privilege('service_role',
       'public.backfill_matricula_stage_carregar(text, jsonb)', 'EXECUTE') then
    raise exception 'service_role nao pode executar a rpc de carga -- a Edge nao carrega';
  end if;

  -- ACL da tabela: service_role sem NADA
  if has_table_privilege('service_role','public.backfill_matricula_stage','INSERT')
  or has_table_privilege('service_role','public.backfill_matricula_stage','SELECT')
  or has_table_privilege('service_role','public.backfill_matricula_stage','UPDATE')
  or has_table_privilege('service_role','public.backfill_matricula_stage','DELETE') then
    raise exception 'service_role ainda alcanca a stage diretamente';
  end if;
  if has_table_privilege('anon','public.backfill_matricula_stage','SELECT')
  or has_table_privilege('authenticated','public.backfill_matricula_stage','SELECT') then
    raise exception 'a stage ficou legivel por anon ou authenticated';
  end if;

  -- o motor continua fechado
  if has_function_privilege('service_role',
       'public.backfill_matricula_aplicar(text, text, integer)', 'EXECUTE') then
    raise exception 'service_role ganhou EXECUTE no motor';
  end if;
end $prova$;

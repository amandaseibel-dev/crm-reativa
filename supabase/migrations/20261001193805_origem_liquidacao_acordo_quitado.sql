-- G2 / etapa 1 de 4 -- PROVENIENCIA DA QUITACAO POR ACORDO
--
-- Problema: quando uma mensalidade vira PAGO/quitada porque o acordo dela foi
-- liquidado, nada registra ISSO. A trinca que responde "por que este titulo
-- fechou" (origem_liquidacao / _ref / _em) ja existe na tabela desde a frente
-- "titulo liquidado na origem pelo Prime", mas e usada por um unico motivo
-- (PRIME_LIQUIDACAO_OFICIAL, 37 linhas em 01/10/2026). A quitacao por acordo --
-- o caminho de longe mais comum -- nao grava nada.
--
-- Sem essa marca nao existe forma segura de desfazer uma quitacao errada: a
-- unica reconstrucao possivel e por padrao de audit_log, que e inferencia. Foi
-- exatamente o que travou o G2 (491 titulos PAGO com acordo ATIVO).
--
-- Esta versao:
--   1) fixa o vocabulario da coluna num check constraint;
--   2) faz titulo_reavaliar gravar a trinca no MESMO update que torna o titulo
--      PAGO -- mesma transacao, sem inferir depois por data, valor ou texto.
--
-- O VELHO VENCE: os tres coalesce garantem que PRIME_LIQUIDACAO_OFICIAL nunca e
-- sobrescrito, mesma regra que titulo_liquidado_na_origem_e_terminal ja aplica.
-- ACORDO_QUITADO nao e terminal: aquele gatilho retorna na primeira linha para
-- qualquer origem diferente de PRIME_LIQUIDACAO_OFICIAL, e e isso que se quer --
-- acordo volta a ATIVO, e a quitacao precisa poder ser desfeita (etapa 3).
--
-- NAO MEXE: valores, vinculos, acordos, parcelas, pagamentos, baixas, auditoria,
-- titularidade, fidelizacao, agenda, honorarios, Preventivo.

-- ---------------------------------------------------------------------------
-- 1) Vocabulario da coluna -- SUBSTITUI o constraint que ja existe
--
-- `acordos_titulos_origem_liquidacao_valida` ja existe e aceita APENAS
-- NULL ou 'PRIME_LIQUIDACAO_OFICIAL'. Descoberto em 01/10/2026 ao rodar a sonda:
-- o patch de titulo_reavaliar tentou gravar ACORDO_QUITADO e o constraint barrou
-- com 23514. Entao nao se acrescenta um segundo check -- amplia-se este, com o
-- MESMO NOME, para nao deixar dois constraints respondendo a mesma pergunta.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from public.acordos_titulos
     where origem_liquidacao is not null
       and origem_liquidacao not in ('PRIME_LIQUIDACAO_OFICIAL','ACORDO_QUITADO')
  ) then
    raise exception 'ABORTADO: existe origem_liquidacao fora do vocabulario -- conferir antes de restringir';
  end if;

  alter table public.acordos_titulos
    drop constraint if exists acordos_titulos_origem_liquidacao_valida;

  alter table public.acordos_titulos
    add constraint acordos_titulos_origem_liquidacao_valida
    check (origem_liquidacao is null
           or origem_liquidacao in ('PRIME_LIQUIDACAO_OFICIAL','ACORDO_QUITADO'));

  -- Nao deixar residuo de nome, caso uma tentativa anterior tenha criado o outro.
  alter table public.acordos_titulos
    drop constraint if exists acordos_titulos_origem_liquidacao_vocab;
end $$;

-- ---------------------------------------------------------------------------
-- 2) titulo_reavaliar grava a trinca -- PATCH ANCORADO
--
-- A funcao tem 5.625 bytes e NAO e retypada aqui de proposito: reescrever corpo
-- inteiro por leitura parcial ja quebrou tela em producao antes. Troca-se apenas
-- o trecho ancorado, e a idempotencia e conferida pelo TEXTO NOVO.
-- ---------------------------------------------------------------------------
do $$
declare
  v_src text;
  v_ancora text := $ancora$    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,$ancora$;
  v_troca text := $troca$    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           origem_liquidacao     = coalesce(origem_liquidacao, 'ACORDO_QUITADO'),
           origem_liquidacao_ref = coalesce(origem_liquidacao_ref, v_acordo::text),
           origem_liquidacao_em  = coalesce(origem_liquidacao_em, now()),$troca$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'titulo_reavaliar'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo uuid';

  if v_src is null then
    raise exception 'ABORTADO: titulo_reavaliar(uuid) nao encontrada';
  end if;

  -- Idempotencia pelo texto NOVO.
  if position(v_troca in v_src) > 0 then
    raise notice 'titulo_reavaliar ja grava a proveniencia -- nada a fazer';
    return;
  end if;

  if position(v_ancora in v_src) = 0 then
    raise exception 'ABORTADO: ancora nao encontrada em titulo_reavaliar -- corpo divergiu, conferir antes';
  end if;

  execute replace(v_src, v_ancora, v_troca);
end $$;

comment on column public.acordos_titulos.origem_liquidacao is
  'POR QUE este titulo fechou. PRIME_LIQUIDACAO_OFICIAL: liquidado na origem pela Prime -- TERMINAL, titulo_liquidado_na_origem_e_terminal recusa qualquer reabertura. ACORDO_QUITADO: quitado junto com o acordo (gravado por titulo_reavaliar no mesmo update) -- reabrivel SOMENTE por titulo_reabrir_quitacao_por_acordo(uuid). Gravada uma vez, nao troca mais.';

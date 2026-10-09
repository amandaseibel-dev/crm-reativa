-- ROLLBACK de 20261008170636_desfecho_devolve_titulo_em_confirmacao.sql
--
-- LEIA ANTES DE RODAR. Este rollback desfaz o COMPORTAMENTO, nao o HISTORICO.
--
-- 1. As colunas `acordos_titulos.devolucao_*` e
--    `parcela_efeito_sem_pagamento_auditoria.titulos_devolvidos_*` NAO sao
--    derrubadas. Elas guardam quem devolveu cada titulo, quando e por que --
--    derruba-las apagaria a unica resposta para "por que este titulo saiu da
--    cobranca?" nos titulos ja devolvidos. Colunas sobrando nao mudam
--    comportamento; apagar prova muda.
--
-- 2. Os titulos ja devolvidos continuam DEVOLVIDO. Para devolve-los a
--    EM_CONFIRMACAO, rode o bloco de DADOS do fim deste arquivo -- de proposito
--    separado, porque e decisao da gestao, nao consequencia automatica de um
--    rollback de codigo.
--
-- 3. O CHECK de `prime_conferencia_decisao.decisao` so volta a recusar
--    'DEVOLVIDO' depois que nenhuma linha usar esse valor. O comando abaixo
--    aborta sozinho se ainda houver -- e esse e o comportamento certo.

-- ---------------------------------------------------------------------------
-- A. CODIGO: volta ao texto de producao de 08/10/2026 (pre-migration)
-- ---------------------------------------------------------------------------
drop function if exists public.devolucao_retroativa_desfecho_do_dia(date, boolean);
drop function if exists public.titulo_devolver_da_confirmacao(uuid, text, text, text);

-- A.1 coerencia situacao <-> status, sem o ramo DEVOLVIDO
create or replace function public._titulo_situacao_e_status_coerentes()
returns trigger
language plpgsql set search_path to 'public'
as $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  elsif v_sit = 'EM_CONFIRMACAO' and v_st <> 'em_confirmacao' then
    -- titulo fora da cobranca aguardando a Conferencia Prime
    new.status := 'em_confirmacao';
  end if;

  return new;
end;
$function$;

-- A.2 e A.3: o motor do desfecho e a reativacao da suspensao voltam ao texto
-- anterior. Os corpos exatos de 08/10/2026 estao no ledger desta rodada:
--   supabase/ledger/2026-10/20261008170636__NOTA.md
-- Reaplique-os de la -- copiar aqui uma segunda versao do mesmo corpo criaria
-- duas verdades para a mesma funcao, que e o que DUAS-TRILHAS.md manda evitar.

-- ---------------------------------------------------------------------------
-- B. VOCABULARIO
-- ---------------------------------------------------------------------------
alter table public.acordos_titulos drop constraint if exists acordos_titulos_devolvido_tem_marca;
alter table public.acordos_titulos drop constraint if exists acordos_titulos_devolucao_origem_valida;
drop index if exists public.idx_acordos_titulos_devolucao;

-- Aborta se ainda existir decisao DEVOLVIDO -- e o que deve acontecer.
alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_decisao_check;
alter table public.prime_conferencia_decisao add constraint prime_conferencia_decisao_decisao_check
  check (decisao = any (array['PENDENTE','CONFIRMADO','VINCULADO','REJEITADO','ENCERRADO_ADMINISTRATIVO']));

-- ---------------------------------------------------------------------------
-- C. DADOS -- NAO roda junto. Decisao da gestao.
-- ---------------------------------------------------------------------------
-- Devolve a EM_CONFIRMACAO os titulos que esta rodada devolveu. A marca
-- `conferencia_prime.decisao` e obrigatoria: sem ela o gatilho
-- `_titulo_em_confirmacao_protegido` levanta excecao na ENTRADA em confirmacao.
--
-- begin;
--   select set_config('conferencia_prime.decisao','on',true);
--   update public.acordos_titulos
--      set situacao='EM_CONFIRMACAO', status='em_confirmacao',
--          devolucao_origem=null, devolucao_ref=null, devolucao_em=null, devolucao_por=null,
--          motivo_ajuste = coalesce(motivo_ajuste,'')
--            || ' | devolucao revertida pelo rollback de 20261008170636',
--          atualizado_em = now()
--    where upper(coalesce(situacao,''))='DEVOLVIDO'
--      and devolucao_em >= timestamptz '2026-10-08 00:00:00-03';
--   select set_config('conferencia_prime.decisao','off',true);
--   update public.prime_conferencia_decisao
--      set decisao='PENDENTE', decidido_por=null, decidido_em=null,
--          motivo='reaberta pelo rollback de 20261008170636'
--    where decisao='DEVOLVIDO';
--   -- confira ANTES de confirmar:
--   select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='DEVOLVIDO';
-- commit;

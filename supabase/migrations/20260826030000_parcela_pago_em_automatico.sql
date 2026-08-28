-- Parcela paga sempre grava QUANDO foi paga.
--
-- Medido em prod 2026-08-25: 144 parcelas com status = 'PAGO' e `pago_em` NULO,
-- somando R$ 723.433,49. Todas pertencem a acordos QUITADO -- ou seja, vieram
-- da quitação em lote ("quitar e encerrar" / "quitar tudo"), que marca a parcela
-- como paga mas NÃO carimba a data.
--
-- Por que isso importa: `pago_em` é a única âncora temporal da liquidação de
-- acordo. Sem ela a parcela existe no saldo mas some de QUALQUER recorte por
-- período -- painel de liquidações, fechamento, conferência de um dia. R$ 723
-- mil de trabalho feito que nenhum relatório consegue mostrar.
-- (R$ 615.110,40 desse total são 9 parcelas de um único acordo, o #1.)
--
-- Duas partes:
--   1) GATILHO -- daqui pra frente, qualquer caminho que marque PAGO sem data
--      recebe a data automaticamente. Vale para RPC, importação, correção
--      manual e qualquer rotina futura: a garantia fica no banco, não em cada
--      chamador. É isso que impede a falha de voltar.
--   2) BACKFILL -- os 144 existentes recebem `parcelas.atualizado_em`, que é
--      quando a linha foi de fato mexida pela quitação. Conferido antes: os 144
--      têm `atualizado_em` preenchido, nenhum anterior ao `criado_em`, faixa
--      entre 07/07 e 25/08. É a data mais verdadeira disponível -- não é chute,
--      mas também não é o extrato: fica anotado na observação como inferida.
--
-- O QUE ESTE GATILHO NÃO FAZ: nunca APAGA `pago_em`. Se uma parcela sair de
-- PAGO (estorno), a data anterior é preservada -- quem estorna decide o que
-- fazer com ela. Hoje a base está coerente (as 1.270 parcelas com `pago_em`
-- são todas PAGO, zero órfã) e este gatilho não assume essa responsabilidade.
--
-- Gatilhos vizinhos conferidos antes de aplicar:
--   _bloquear_parcela_baixa_acordo_encerrado -- BEFORE UPDATE, só dispara na
--     TRANSIÇÃO para PAGO (old.status <> 'PAGO'). O backfill não mexe em status,
--     então não dispara e o guard de acordo cancelado segue intacto.
--   trg_auto_quitar_parcela -- AFTER UPDATE OF status; o backfill não toca em
--     status, não dispara.
--   trg_recalc_parcela -- dispara em qualquer update; recalcula 144 casos, que
--     é o comportamento desejado.
--
-- Rollback: supabase/rollbacks/20260826030000_parcela_pago_em_automatico.rollback.sql

------------------------------------------------------------------------------
-- 1) Gatilho: PAGO sem data recebe a data, sempre
------------------------------------------------------------------------------
create or replace function public._parcela_pago_em_automatico()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  -- só preenche o que está faltando; uma data informada explicitamente vence.
  if new.status = 'PAGO' and new.pago_em is null then
    new.pago_em := now();
  end if;
  return new;
end;
$$;

comment on function public._parcela_pago_em_automatico() is
  'Carimba pago_em quando a parcela vira PAGO sem data. Nunca sobrescreve data informada nem apaga data existente.';

drop trigger if exists trg_parcela_pago_em_automatico on public.parcelas;
create trigger trg_parcela_pago_em_automatico
  before insert or update on public.parcelas
  for each row execute function public._parcela_pago_em_automatico();

------------------------------------------------------------------------------
-- 2) Backfill dos 144 já existentes
------------------------------------------------------------------------------
update public.parcelas p
   set pago_em = p.atualizado_em,
       observacao = coalesce(nullif(p.observacao, ''), '') ||
                    case when coalesce(p.observacao, '') = '' then '' else ' | ' end ||
                    'data de pagamento inferida da atualizacao do registro (backfill_pago_em_20260826)'
 where p.status = 'PAGO'
   and p.pago_em is null
   and p.atualizado_em is not null;

------------------------------------------------------------------------------
-- 3) Conferência: não pode sobrar parcela paga sem data
------------------------------------------------------------------------------
do $$
declare v_restante integer; v_backfill integer;
begin
  select count(*) into v_restante from public.parcelas where status='PAGO' and pago_em is null;
  select count(*) into v_backfill from public.parcelas where observacao like '%backfill_pago_em_20260826%';
  raise notice 'Backfill aplicado em % parcelas. Ainda sem data: %.', v_backfill, v_restante;
end $$;

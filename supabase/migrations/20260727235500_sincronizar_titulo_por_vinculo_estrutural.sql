-- Hotfix ESTRUTURAL (A): "mensalidades vinculadas continuam em aberto".
--
-- Escopo desta migration: SOMENTE a correcao estrutural do fluxo de vinculo.
-- NAO altera nenhum dado historico (nenhum dos 25 titulos divergentes e tocado).
-- A analise da reconciliacao historica ficou FORA de migrations, em
-- supabase/audits/reconciliar_titulos_negociados_orfaos.sql -- material de
-- estudo, nunca executado automaticamente. Rollback em supabase/rollbacks/.
--
-- Causa (reproduzida em producao, BEGIN/ROLLBACK):
-- O vinculo mensalidade->acordo era mantido por caminhos nao-transacionais e
-- sobrepostos, gravando em campos diferentes:
--   * Frontend FinanceiroAluno.vincularTitulosExistente faz DUAS escritas
--     separadas -> (1) INSERT em acordo_titulo_vinculo e (2) UPDATE
--     acordos_titulos.status='vinculada'. Sem transacao: se a 2a falha, fica
--     situacao=NEGOCIADO e status='em_aberto' (escrita parcial).
--   * Trigger antigo titulo_situacao_por_vinculo() so ajustava `situacao`
--     (ABERTO<->NEGOCIADO), ignorando `status` e `acordo_id`, e NAO tratava
--     DELETE. No desvinculo/cancelamento a linha de vinculo e deletada sem
--     recalcular o titulo.
-- Resultado: titulos NEGOCIADO/status=em_aberto sem vinculo ativo, com as tres
-- nocoes de "em aberto" divergindo (saldo conta; lista esconde; selecionaveis
-- lista).
--
-- Correcao estrutural (minima, idempotente, transacional -- sem escrita parcial):
-- titulo_situacao_por_vinculo() vira a UNICA fonte de verdade do estado do
-- titulo negociado. Dispara em INSERT/UPDATE/DELETE de acordo_titulo_vinculo e,
-- para o titulo afetado (NEW e OLD -- cobre troca de titulo/acordo no UPDATE),
-- recalcula de forma atomica e idempotente:
--   - titulo ja PAGO/quitada: NAO mexe (nunca reabrir pago);
--   - existe vinculo ATIVO p/ acordo nao-cancelado: situacao='NEGOCIADO',
--     status='vinculada', acordo_id = acordo do vinculo;
--   - sem vinculo ativo valido: situacao='ABERTO', status='em_aberto',
--     acordo_id=null.
-- Nao marca QUITADA/PAGA apenas pelo vinculo. Quitacao (titulos_por_status_acordo)
-- e o gate de titularidade (RLS de acordo_titulo_vinculo) permanecem inalterados.

create or replace function public.titulo_situacao_por_vinculo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_titulos uuid[] := array(select distinct x from unnest(array[new.titulo_id, old.titulo_id]) x where x is not null);
  v_titulo uuid;
  v_situacao text;
  v_status text;
  v_acordo uuid;
begin
  -- Recalcula TODOS os titulos tocados pela linha (no UPDATE que troca o
  -- titulo_id, recalcula OLD e NEW).
  foreach v_titulo in array v_titulos loop
    select situacao, status into v_situacao, v_status
      from public.acordos_titulos where id = v_titulo;

    -- Nunca reabrir/alterar titulo ja pago/quitado apenas por (des)vinculo.
    if upper(coalesce(v_situacao,'')) = 'PAGO'
       or lower(coalesce(v_status,'')) in ('quitada','paga') then
      continue;
    end if;

    -- Existe vinculo ATIVO para acordo nao-cancelado? Qual acordo?
    select v.acordo_id into v_acordo
      from public.acordo_titulo_vinculo v
      join public.acordos a on a.id = v.acordo_id
     where v.titulo_id = v_titulo
       and coalesce(v.ativo, true)
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     order by v.criado_em desc nulls last
     limit 1;

    if v_acordo is not null then
      update public.acordos_titulos
         set situacao = 'NEGOCIADO', status = 'vinculada',
             acordo_id = v_acordo, atualizado_em = now()
       where id = v_titulo
         and (coalesce(situacao,'') <> 'NEGOCIADO'
              or coalesce(status,'') <> 'vinculada'
              or acordo_id is distinct from v_acordo);
    else
      update public.acordos_titulos
         set situacao = 'ABERTO', status = 'em_aberto',
             acordo_id = null, atualizado_em = now()
       where id = v_titulo
         and (coalesce(situacao,'') <> 'ABERTO'
              or coalesce(status,'') <> 'em_aberto'
              or acordo_id is not null);
    end if;
  end loop;

  return coalesce(new, old);
end;
$function$;

drop trigger if exists trg_titulo_situacao_por_vinculo on public.acordo_titulo_vinculo;
create trigger trg_titulo_situacao_por_vinculo
after insert or update or delete on public.acordo_titulo_vinculo
for each row execute function public.titulo_situacao_por_vinculo();

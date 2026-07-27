-- Hotfix: "mensalidades vinculadas continuam em aberto".
--
-- Causa (reproduzida em producao, leitura/BEGIN-ROLLBACK):
-- O vinculo mensalidade->acordo e mantido por VARIOS caminhos nao-transacionais
-- e sobrepostos, que gravam em campos diferentes:
--   * Frontend FinanceiroAluno.vincularTitulosExistente: faz DUAS escritas
--     separadas -> (1) INSERT em acordo_titulo_vinculo e (2) UPDATE
--     acordos_titulos.status='vinculada'. Sem transacao: se a 2a falha (RLS,
--     rede), fica situacao=NEGOCIADO (via trigger) e status='em_aberto'.
--   * Trigger antigo titulo_situacao_por_vinculo(): so ajustava `situacao`
--     (ABERTO<->NEGOCIADO), ignorando `status` e `acordo_id`, e NAO tratava
--     DELETE. No cancelamento/desvinculo o frontend deleta a linha de
--     acordo_titulo_vinculo -> nenhum trigger recalcula `situacao`, que fica
--     "orfa" em NEGOCIADO.
-- Resultado: titulos NEGOCIADO/status=em_aberto SEM vinculo ativo. As tres
-- nocoes de "em aberto" divergem:
--   - aluno_saldo_pendente_detalhe conta o titulo (bucket titulos_negociados_orfaos)
--     -> soma no total (saldo fantasma);
--   - lista da ficha (situacao<>NEGOCIADO) esconde;
--   - titulosSelecionaveis (status='em_aberto') ainda lista como aberto.
-- Medido: 25 titulos orfaos, 11 alunos, ~R$47,5 mil fantasma.
--
-- Correcao (minima, idempotente, transacional -- sem escrita parcial):
--   1) titulo_situacao_por_vinculo() vira a UNICA fonte de verdade do estado do
--      titulo negociado. Dispara em INSERT/UPDATE/DELETE de acordo_titulo_vinculo
--      e, para o titulo afetado, recalcula de forma atomica e idempotente:
--        - titulo ja PAGO/quitada: NAO mexe (nunca reabrir pago);
--        - existe vinculo ATIVO p/ acordo nao-cancelado: situacao='NEGOCIADO',
--          status='vinculada', acordo_id = acordo do vinculo;
--        - sem vinculo ativo valido: situacao='ABERTO', status='em_aberto',
--          acordo_id=null (recalculo no desvinculo/cancelamento).
--      Assim o vinculo e o status andam juntos numa unica transacao; o UPDATE
--      separado do frontend passa a ser redundante/idempotente, e o DELETE do
--      desvinculo recalcula corretamente. Nao marca QUITADA/PAGA so pelo vinculo.
--   2) Reconciliacao unica e idempotente dos titulos ja divergentes, aplicando a
--      MESMA regra (sem tocar em quitada/paga). Limpa os orfaos existentes.
--
-- Quitacao de acordo (status QUITADO -> titulos 'quitada'/'PAGO') e o gate de
-- titularidade (RLS de acordo_titulo_vinculo: gestao ou dono do acordo)
-- permanecem inalterados. Nenhuma permissao ampla e reaberta.

-- 1) Trigger transacional unico (INSERT/UPDATE/DELETE).
create or replace function public.titulo_situacao_por_vinculo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_titulo uuid := coalesce(new.titulo_id, old.titulo_id);
  v_situacao text;
  v_status text;
  v_acordo uuid;
begin
  if v_titulo is null then
    return coalesce(new, old);
  end if;

  select situacao, status into v_situacao, v_status
    from public.acordos_titulos where id = v_titulo;

  -- Nunca reabrir/alterar titulo ja pago/quitado apenas por (des)vinculo.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return coalesce(new, old);
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
    -- Vinculado: sai de "em aberto", vira negociado/vinculada (idempotente).
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = v_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  else
    -- Sem vinculo ativo valido: volta para aberto (idempotente).
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = v_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
  end if;

  return coalesce(new, old);
end;
$function$;

drop trigger if exists trg_titulo_situacao_por_vinculo on public.acordo_titulo_vinculo;
create trigger trg_titulo_situacao_por_vinculo
after insert or update or delete on public.acordo_titulo_vinculo
for each row execute function public.titulo_situacao_por_vinculo();

-- 2) Reconciliacao idempotente dos titulos ja divergentes (nao mexe em pago).
--    a) Titulos com vinculo ATIVO valido, nao pagos -> NEGOCIADO/vinculada + acordo_id.
update public.acordos_titulos t
   set situacao = 'NEGOCIADO', status = 'vinculada',
       acordo_id = sub.acordo_id, atualizado_em = now()
  from (
    select distinct on (v.titulo_id) v.titulo_id, v.acordo_id
      from public.acordo_titulo_vinculo v
      join public.acordos a on a.id = v.acordo_id
     where coalesce(v.ativo, true)
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
     order by v.titulo_id, v.criado_em desc nulls last
  ) sub
 where t.id = sub.titulo_id
   and upper(coalesce(t.situacao,'')) <> 'PAGO'
   and lower(coalesce(t.status,'')) not in ('quitada','paga')
   and (coalesce(t.situacao,'') <> 'NEGOCIADO'
        or coalesce(t.status,'') <> 'vinculada'
        or t.acordo_id is distinct from sub.acordo_id);

--    b) Titulos NEGOCIADO sem vinculo ativo valido (orfaos), nao pagos -> ABERTO/em_aberto.
update public.acordos_titulos t
   set situacao = 'ABERTO', status = 'em_aberto',
       acordo_id = null, atualizado_em = now()
 where upper(coalesce(t.situacao,'')) = 'NEGOCIADO'
   and lower(coalesce(t.status,'')) not in ('quitada','paga')
   and not exists (
     select 1 from public.acordo_titulo_vinculo v
       join public.acordos a on a.id = v.acordo_id
      where v.titulo_id = t.id
        and coalesce(v.ativo, true)
        and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   );

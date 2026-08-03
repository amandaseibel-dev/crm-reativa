-- =====================================================================
-- Ajustes tela de acordos (financeiro): guard de acoes financeiras em
-- acordos encerrados + hardening da vinculacao de mensalidades.
--
-- NAO altera valores, parcelas, pagamentos, baixas ou status de nenhum
-- acordo existente. Apenas cria regra central + travas de escrita.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Regra central: um acordo permite acao financeira?
--    Encerrados (CANCELADO / QUITADO) => nao.
-- ---------------------------------------------------------------------
create or replace function public.acordo_permite_acao_financeira(p_acordo_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- true apenas para acordo existente e nao encerrado (CANCELADO/QUITADO).
  -- acordo inexistente => false.
  select exists (select 1 from public.acordos where id = p_acordo_id)
     and not exists (
           select 1 from public.acordos
            where id = p_acordo_id
              and upper(coalesce(status,'')) in ('CANCELADO','QUITADO')
         );
$function$;

grant execute on function public.acordo_permite_acao_financeira(uuid) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------
-- 2) Trava de backend: bloqueia registrar baixa em acordo encerrado.
--    baixas_pagamento carrega acordo_id -> antes de inserir/atualizar
--    uma baixa REALIZADA, o acordo alvo precisa permitir acao financeira.
--    Estornos (status_baixa DEVOLVIDA) continuam permitidos.
-- ---------------------------------------------------------------------
create or replace function public._bloquear_baixa_acordo_encerrado()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  -- So interessa quando ha acordo vinculado e a baixa esta sendo efetivada.
  if new.acordo_id is null then
    return new;
  end if;
  if coalesce(new.status_baixa,'') <> 'REALIZADA' then
    return new;  -- devolucao/estorno nao e bloqueado
  end if;

  select upper(coalesce(status,'')) into v_status
  from public.acordos where id = new.acordo_id;

  if v_status = 'CANCELADO' then
    raise exception 'acordo_cancelado_operacao_nao_permitida'
      using errcode = 'P0001';
  elsif v_status = 'QUITADO' then
    raise exception 'acordo_quitado_operacao_nao_permitida'
      using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_bloquear_baixa_acordo_encerrado on public.baixas_pagamento;
create trigger trg_bloquear_baixa_acordo_encerrado
  before insert or update on public.baixas_pagamento
  for each row execute function public._bloquear_baixa_acordo_encerrado();

-- ---------------------------------------------------------------------
-- 3) Trava de backend: bloqueia dar baixa (status PAGO) numa parcela
--    de acordo CANCELADO. Estornos (PAGO -> A_VENCER) seguem liberados,
--    entao desfazer baixa de acordo QUITADO continua funcionando.
-- ---------------------------------------------------------------------
create or replace function public._bloquear_parcela_baixa_acordo_encerrado()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status text;
begin
  -- So barra a transicao para PAGO (efetivacao de baixa).
  if new.status = 'PAGO' and coalesce(old.status,'') is distinct from 'PAGO' then
    select upper(coalesce(status,'')) into v_status
    from public.acordos where id = new.acordo_id;
    if v_status = 'CANCELADO' then
      raise exception 'acordo_cancelado_operacao_nao_permitida'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_bloquear_parcela_baixa_acordo_encerrado on public.parcelas;
create trigger trg_bloquear_parcela_baixa_acordo_encerrado
  before update on public.parcelas
  for each row execute function public._bloquear_parcela_baixa_acordo_encerrado();

-- ---------------------------------------------------------------------
-- 4) Hardening da vinculacao de mensalidades ao acordo.
--    - lock por acordo (advisory) evita corrida
--    - lock das linhas (FOR UPDATE) evita mudanca concorrente
--    - re-valida elegibilidade no backend (nao confia no front)
--    - se QUALQUER titulo pedido estiver inelegivel, NAO vincula nada
--      e devolve a lista de bloqueados (evita acordo parcial silencioso)
--    - so vincula em acordo ATIVO
-- ---------------------------------------------------------------------
create or replace function public.vincular_titulos_acordo(p_titulo_ids uuid[], p_acordo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.email(),''));
  v_aluno_acordo uuid;
  v_status_acordo text;
  v_bloqueados uuid[];
  v_n int;
begin
  if v_email = '' then return jsonb_build_object('ok',false,'erro','NAO_AUTENTICADO'); end if;
  if p_acordo_id is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;
  if p_titulo_ids is null or array_length(p_titulo_ids,1) is null then
    return jsonb_build_object('ok',false,'erro','SEM_TITULOS');
  end if;

  -- Serializa vinculacoes concorrentes no mesmo acordo.
  perform pg_advisory_xact_lock(hashtextextended(p_acordo_id::text, 0));

  select aluno_id, upper(coalesce(status,'')) into v_aluno_acordo, v_status_acordo
  from public.acordos where id = p_acordo_id;
  if v_aluno_acordo is null then return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ENCONTRADO'); end if;

  -- Acordo CANCELADO nunca recebe vinculo. QUITADO e permitido de proposito:
  -- e um fluxo existente vincular mensalidades ja cobertas a um acordo quitado
  -- (nao efetiva pagamento nem reabre cobranca). Baixa em quitado segue barrada
  -- pelos triggers de baixa.
  if v_status_acordo = 'CANCELADO' then
    return jsonb_build_object('ok',false,'erro','acordo_cancelado_operacao_nao_permitida');
  elsif v_status_acordo not in ('ATIVO','QUITADO') then
    return jsonb_build_object('ok',false,'erro','ACORDO_NAO_ATIVO');
  end if;

  -- Trava as linhas alvo para evitar mudanca de status concorrente.
  perform 1 from public.acordos_titulos where id = any(p_titulo_ids) for update;

  -- Elegibilidade (espelha titulos_disponiveis_para_acordo, mais rigoroso):
  -- mesmo aluno, sem acordo, nao vinculada, nao negociada, nao paga,
  -- nao duplicada e com saldo > 0.
  select array_agg(t.id) into v_bloqueados
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and not (
          t.aluno_id = v_aluno_acordo
      and t.acordo_id is null
      and coalesce(t.status,'') <> 'vinculada'
      and coalesce(t.status,'') <> 'quitada'
      and coalesce(t.situacao,'') not in ('NEGOCIADO','PAGO','DUPLICADA')
      and coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0) > 0
    );

  if v_bloqueados is not null and array_length(v_bloqueados,1) > 0 then
    return jsonb_build_object(
      'ok', false,
      'erro', 'PARCELAS_INELEGIVEIS',
      'bloqueados', to_jsonb(v_bloqueados)
    );
  end if;

  -- Vincula (agora garantidamente elegiveis).
  update public.acordos_titulos t
     set acordo_id = p_acordo_id,
         situacao = 'NEGOCIADO',
         status = 'vinculada',
         vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
   where t.id = any(p_titulo_ids)
     and t.aluno_id = v_aluno_acordo;
  get diagnostics v_n = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, vinculado_por, criado_em)
  select p_acordo_id, t.id, true, v_email, now()
  from public.acordos_titulos t
  where t.id = any(p_titulo_ids)
    and t.aluno_id = v_aluno_acordo
    and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'VINCULOU_TITULOS_ACORDO', 'acordos_titulos', p_acordo_id,
          jsonb_build_object('acordo_id', p_acordo_id, 'qtd', v_n, 'titulo_ids', p_titulo_ids));

  return jsonb_build_object('ok', true, 'vinculados', v_n, 'acordo_id', p_acordo_id);
end;
$function$;

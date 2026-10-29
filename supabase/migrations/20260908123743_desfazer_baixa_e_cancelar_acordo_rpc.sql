-- Estorno de baixa e cancelamento de acordo em uma transacao so.
--
-- Continuacao da migration 20260908150000 (baixa de parcela). Depois de
-- mover a baixa para RPC, sobraram na ficha (FinanceiroAluno.jsx) dois
-- caminhos que ainda escreviam solto pelo supabase-js, em varios awaits sem
-- checar erro no meio:
--
-- 1. desfazerBaixa: baixas_pagamento -> DEVOLVIDA, parcela -> A_VENCER e, se
--    o acordo estava QUITADO, acordo -> ATIVO com saldo recalculado, titulos
--    -> vinculada, carteira_operador -> ativo e aluno -> EM_ATENDIMENTO.
--    Sete escritas; se a terceira falhava, a parcela ja estava reaberta e o
--    acordo continuava QUITADO.
-- 2. excluirAcordo (cancelar): titulos -> em_aberto, vinculos apagados,
--    parcelas -> CANCELADA, acordo -> CANCELADO, caso liberado por evento.
--    Cinco escritas, mesmo risco.
--
-- Agora cada um e uma RPC SECURITY DEFINER com teto de 60 s: ou grava tudo
-- ou nao grava nada. A logica e a mesma que a tela fazia; as diferencas sao
-- (a) a parcela estornada volta como VENCIDA quando o vencimento ja passou
-- (a tela gravava sempre A_VENCER e o cron das 03:05 corrigia no dia
-- seguinte) e (b) o saldo do acordo reaberto e calculado no banco, depois
-- da parcela voltar, e nao por uma segunda leitura da tela.
--
-- Quem pode: crm_usuario_pode_quitar_baixar() -- os mesmos tres e-mails
-- que a tela ja exigia (podeBaixar) para mostrar os dois botoes.

create or replace function public.desfazer_baixa_parcela(p_parcela_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $$
declare
  v_email    text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_agora    timestamptz := now();
  v_parc     public.parcelas%rowtype;
  v_acordo   public.acordos%rowtype;
  v_reabriu  boolean := false;
  v_saldo    numeric := 0;
  v_baixas   int := 0;
  v_titulos  int := 0;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Estorno de baixa e exclusivo da gestao financeira.' using errcode = '42501';
  end if;

  select * into v_parc from public.parcelas where id = p_parcela_id for update;
  if not found then
    raise exception 'Parcela nao encontrada.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_parc.status, '')) <> 'PAGO' then
    raise exception 'Esta parcela nao esta paga -- nao ha baixa para desfazer.' using errcode = 'P0001';
  end if;

  select * into v_acordo from public.acordos where id = v_parc.acordo_id for update;
  if not found then
    raise exception 'Acordo da parcela nao encontrado.' using errcode = 'P0001';
  end if;

  -- baixas_pagamento nao tem politica de DELETE; a convencao da tela e
  -- marcar como devolvida, e o registro fica para auditoria.
  update public.baixas_pagamento
     set status_baixa = 'DEVOLVIDA',
         devolvido_por_email = v_email,
         devolvido_em = v_agora,
         motivo_devolucao = 'Baixa desfeita na ficha do aluno (correcao)',
         atualizado_em = v_agora
   where parcela_id = p_parcela_id
     and coalesce(status_baixa, '') <> 'DEVOLVIDA';
  get diagnostics v_baixas = row_count;

  update public.parcelas
     set status = case when vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
         pago_em = null,
         confirmado_por_email = null,
         atualizado_em = v_agora
   where id = p_parcela_id;

  if upper(coalesce(v_acordo.status, '')) = 'QUITADO' then
    v_reabriu := true;

    select coalesce(sum(valor), 0) into v_saldo
      from public.parcelas
     where acordo_id = v_acordo.id
       and upper(coalesce(status, '')) <> 'PAGO';

    update public.acordos
       set status = 'ATIVO', saldo = v_saldo, atualizado_em = v_agora
     where id = v_acordo.id;

    update public.acordos_titulos t
       set status = 'vinculada', atualizado_em = v_agora
     where t.id in (select v.titulo_id from public.acordo_titulo_vinculo v
                     where v.acordo_id = v_acordo.id and coalesce(v.ativo, true));
    get diagnostics v_titulos = row_count;

    if v_acordo.aluno_id is not null then
      update public.carteira_operador
         set status = 'ativo', saiu_em = null
       where aluno_id = v_acordo.aluno_id and status = 'quitado_saiu';

      -- So reverte quem ainda esta QUITADO por causa desse acordo; se ja
      -- mudou por outro motivo, nao mexe.
      update public.alunos
         set status_jornada = 'EM_ATENDIMENTO',
             status_atual = 'EM_ATENDIMENTO',
             status_acionamento = 'EM_ATENDIMENTO',
             proxima_acao = 'CONTATAR'
       where id = v_acordo.aluno_id and status_jornada = 'QUITADO';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'parcela_id', p_parcela_id,
    'baixas_devolvidas', v_baixas,
    'acordo_reaberto', v_reabriu,
    'saldo_acordo', v_saldo,
    'titulos_revinculados', v_titulos
  );
end;
$$;

revoke all on function public.desfazer_baixa_parcela(uuid) from public, anon;
grant execute on function public.desfazer_baixa_parcela(uuid) to authenticated, service_role;

comment on function public.desfazer_baixa_parcela(uuid) is
  'Desfaz a baixa de uma parcela (baixa DEVOLVIDA, parcela reaberta e, se o acordo estava QUITADO, acordo/titulos/carteira/aluno reabertos) na mesma transacao, teto 60s. Substitui os 7 awaits soltos da ficha. So gestao financeira.';


create or replace function public.cancelar_acordo_ficha(p_acordo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $$
declare
  v_agora    timestamptz := now();
  v_acordo   public.acordos%rowtype;
  v_titulos  int := 0;
  v_vinculos int := 0;
  v_parcelas int := 0;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Cancelar acordo e exclusivo da gestao financeira.' using errcode = '42501';
  end if;

  select * into v_acordo from public.acordos where id = p_acordo_id for update;
  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo ja esta cancelado.' using errcode = 'P0001';
  end if;

  -- Protege historico financeiro real: com parcela paga ou baixa viva, nao
  -- cancela por aqui (mesmas duas travas que a tela ja tinha).
  if exists (select 1 from public.parcelas where acordo_id = p_acordo_id and upper(coalesce(status, '')) = 'PAGO') then
    raise exception 'Esse acordo ja tem parcela paga -- nao da pra cancelar (protege o historico financeiro). Se foi um erro, fale com quem confirmou o pagamento antes de mexer.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.baixas_pagamento where acordo_id = p_acordo_id and devolvido_em is null) then
    raise exception 'Esse acordo ja tem alguma baixa/pagamento registrado -- nao da pra cancelar por aqui.' using errcode = 'P0001';
  end if;

  update public.acordos_titulos t
     set status = 'em_aberto', atualizado_em = v_agora
   where t.id in (select v.titulo_id from public.acordo_titulo_vinculo v where v.acordo_id = p_acordo_id);
  get diagnostics v_titulos = row_count;

  delete from public.acordo_titulo_vinculo where acordo_id = p_acordo_id;
  get diagnostics v_vinculos = row_count;

  update public.parcelas
     set status = 'CANCELADA', atualizado_em = v_agora
   where acordo_id = p_acordo_id
     and upper(coalesce(status, '')) <> 'PAGO';
  get diagnostics v_parcelas = row_count;

  update public.acordos
     set status = 'CANCELADO', saldo = 0, atualizado_em = v_agora
   where id = p_acordo_id;

  -- Sinaliza que o caso saiu da carteira ativa (mesmo mecanismo que a tela
  -- chamava em seguida, agora dentro da mesma transacao).
  if v_acordo.aluno_id is not null then
    perform public.liberar_caso_por_evento(v_acordo.aluno_id, 'CANCELADO');
  end if;

  return jsonb_build_object(
    'ok', true,
    'acordo_id', p_acordo_id,
    'titulos_reabertos', v_titulos,
    'vinculos_removidos', v_vinculos,
    'parcelas_canceladas', v_parcelas
  );
end;
$$;

revoke all on function public.cancelar_acordo_ficha(uuid) from public, anon;
grant execute on function public.cancelar_acordo_ficha(uuid) to authenticated, service_role;

comment on function public.cancelar_acordo_ficha(uuid) is
  'Cancela um acordo sem parcela paga nem baixa viva: titulos em_aberto, vinculos removidos, parcelas CANCELADA, acordo CANCELADO e caso liberado, na mesma transacao, teto 60s. Substitui os 5 awaits soltos da ficha. So gestao financeira.';

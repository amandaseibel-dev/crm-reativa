-- Reparo das baixas automaticas que cairam na parcela errada.
--
-- Amanda, 08/09/2026, sobre a lista de 89 baixas / 65 alunos: "pode fazer" e
-- "faca tudo que puder automatizado".
--
-- O QUE A LISTA MOSTROU: quase sempre sao duas ou tres baixas do MESMO acordo
-- apontando para a mesma parcela aberta (ex.: Ana Julia, acordo 1971 --
-- parcelas 3 e 4 marcadas, 1 e 2 abertas; os pagamentos de 28/07 e 28/08 sao
-- as parcelas 1 e 2). Mover cada baixa "para a parcela aberta anterior" nao
-- resolve: as duas cairiam na mesma. O reparo certo e, por acordo,
-- DESMARCAR todas as baixas automaticas e REAPLICAR cada pagamento, em ordem
-- de data, na parcela certa:
--   - se a linha do extrato traz o vencimento do boleto, na parcela daquele
--     vencimento (+-3 dias);
--   - senao, na parcela aberta mais antiga do acordo, desde que o valor bata
--     (+-R$ 0,05).
-- O documento (boleto) viaja junto com o pagamento para a parcela certa, o
-- registro em baixas_pagamento e apontado para ela, e o que nao encontra
-- destino fica aberto e listado -- ninguem inventa parcela paga.
--
-- Pagamento que ja tem baixa MANUAL na mesma data (Conferencia de Pagamentos)
-- nao e reaplicado: seria contar o mesmo dinheiro duas vezes (Kleiton, 08/09:
-- o gatilho baixou a parcela 4 e a Fernanda baixou a 1 com o mesmo R$ 317,34).
--
-- Universo: acordos ATIVOS com pelo menos uma baixa automatica numa parcela
-- futura enquanto uma anterior segue aberta e a data do pagamento bate melhor
-- com a aberta (medido em 08/09: 65 acordos, 97 baixas automaticas).
-- Parcelas pagas por outro caminho nao sao tocadas.
--
-- p_confirmar = false: roda tudo e DESFAZ no fim, devolvendo o plano.
-- p_confirmar = true: grava, com backup em _backup_reparo_baixa_documento_*.

create or replace function public.baixa_documento_reparar(p_confirmar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $$
declare
  v_lote text := 'reparo_baixa_documento_' || to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  v_hoje text := to_char(current_date,'DD/MM/YYYY');
  r record; v_alvo uuid; v_alvo_num int; v_alvo_venc date;
  v_acordos int := 0; v_reaplicadas int := 0; v_no_lugar int := 0; v_sem_destino int := 0; v_ja_manual int := 0;
  v_plano jsonb := '[]'::jsonb;
  v_res jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao()
     and current_user not in ('postgres','supabase_admin') then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  -- 1. Universo: acordos com baixa automatica fora de ordem.
  create temp table _rep_acordos on commit drop as
  with auto as (
    select p.id, p.acordo_id, p.vencimento, p.pago_em::date dt, a.aluno_id
      from public.parcelas p join public.acordos a on a.id = p.acordo_id
     where p.status = 'PAGO' and p.pago_em >= '2026-07-01'
       and upper(coalesce(a.status,'')) = 'ATIVO'
       and (p.observacao ilike '%pelo documento%' or p.observacao ilike '%baixa automatica%')
  )
  select distinct x.acordo_id, x.aluno_id
    from auto x
   where exists (select 1 from public.parcelas y
                  where y.acordo_id = x.acordo_id and y.status in ('VENCIDA','A_VENCER')
                    and y.vencimento < x.vencimento
                    and abs(x.dt - y.vencimento) < abs(x.dt - x.vencimento));

  select count(*) into v_acordos from _rep_acordos;

  -- 2. Os "pagamentos" a reaplicar: toda baixa automatica desses acordos.
  create temp table _rep_pag on commit drop as
  select p.id parcela_origem, p.acordo_id, ra.aluno_id, p.numero, p.vencimento, p.valor, p.pago_em,
         p.confirmado_por_email, p.honorarios, p.boleto, p.observacao,
         (select public.vencimento_do_pagamento(g.dados) from public.pagamentos g
           where ltrim(coalesce(g.numero_parcela_completo,''),'0') = p.boleto
             and g.data_pagamento = p.pago_em::date limit 1) venc_extrato,
         exists (select 1 from public.baixas_pagamento b
                  where b.aluno_id = ra.aluno_id::text and b.data_pagamento = p.pago_em::date
                    and b.status_baixa = 'REALIZADA'
                    and coalesce(b.baixado_por_email,'') <> 'rotina@sistema'
                    and (b.parcela_id is null or b.parcela_id <> p.id)
                    and abs(coalesce(b.valor_pago,0) - p.valor) <= p.valor * 0.15) ja_manual
    from public.parcelas p join _rep_acordos ra on ra.acordo_id = p.acordo_id
   where p.status = 'PAGO'
     and (p.observacao ilike '%pelo documento%' or p.observacao ilike '%baixa automatica%');

  begin
    -- 3. Backup das parcelas desses acordos.
    execute format('create table public.%I as select p.*, now() salvo_em from public.parcelas p where p.acordo_id in (select acordo_id from _rep_acordos)', '_backup_' || v_lote);
    execute format('alter table public.%I enable row level security', '_backup_' || v_lote);

    -- 4. Desmarca todas as baixas automaticas desses acordos.
    update public.parcelas p
       set status = case when p.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
           pago_em = null, confirmado_por_email = null, boleto = null,
           observacao = coalesce(p.observacao,'') || ' | reparo ' || v_hoje || ': baixa automatica reaplicada na parcela certa',
           atualizado_em = now()
      from _rep_pag rp where p.id = rp.parcela_origem;

    -- 5. Reaplica em ordem de data.
    for r in select * from _rep_pag order by acordo_id, pago_em, numero loop
      v_alvo := null;

      if r.ja_manual then
        v_ja_manual := v_ja_manual + 1;
        v_plano := v_plano || jsonb_build_object('acordo', r.acordo_id, 'aluno', r.aluno_id, 'de_parcela', r.numero, 'pago_em', r.pago_em::date, 'valor', r.valor, 'resultado', 'ja coberto por baixa manual na mesma data: fica aberta');
        continue;
      end if;

      if r.venc_extrato is not null then
        select id, numero, vencimento into v_alvo, v_alvo_num, v_alvo_venc
          from public.parcelas
         where acordo_id = r.acordo_id and status in ('VENCIDA','A_VENCER')
           and abs(vencimento - r.venc_extrato) <= 3 and abs(valor - r.valor) <= 0.05
         order by abs(vencimento - r.venc_extrato) limit 1;
      end if;

      if v_alvo is null then
        select id, numero, vencimento into v_alvo, v_alvo_num, v_alvo_venc
          from public.parcelas
         where acordo_id = r.acordo_id and status in ('VENCIDA','A_VENCER')
         order by vencimento, numero limit 1;
        if v_alvo is not null and not exists (select 1 from public.parcelas where id = v_alvo and abs(valor - r.valor) <= 0.05) then
          v_alvo := null;
        end if;
      end if;

      if v_alvo is null then
        v_sem_destino := v_sem_destino + 1;
        v_plano := v_plano || jsonb_build_object('acordo', r.acordo_id, 'aluno', r.aluno_id, 'de_parcela', r.numero, 'pago_em', r.pago_em::date, 'valor', r.valor, 'resultado', 'sem parcela aberta com esse valor: fica aberta, conferir a mao');
        continue;
      end if;

      update public.parcelas
         set status = 'PAGO', pago_em = r.pago_em, confirmado_por_email = r.confirmado_por_email,
             honorarios = coalesce(nullif(honorarios,0), r.honorarios),
             boleto = case when r.boleto is not null and not exists (select 1 from public.parcelas z where z.boleto = r.boleto and z.id <> v_alvo) then r.boleto else boleto end,
             observacao = coalesce(observacao,'') || case when coalesce(observacao,'') = '' then '' else ' | ' end
                          || 'reparo ' || v_hoje || ': baixa pelo documento ' || coalesce(r.boleto,'?')
                          || ' (pago em ' || to_char(r.pago_em,'DD/MM/YYYY') || ') movida da parcela ' || r.numero
                          || case when r.venc_extrato is not null then ', vencimento ' || to_char(r.venc_extrato,'DD/MM/YYYY') || ' conferido no extrato' else ', parcela aberta mais antiga' end,
             atualizado_em = now()
       where id = v_alvo;

      update public.baixas_pagamento set parcela_id = v_alvo, atualizado_em = now()
       where parcela_id = r.parcela_origem;

      if v_alvo = r.parcela_origem then v_no_lugar := v_no_lugar + 1; else v_reaplicadas := v_reaplicadas + 1; end if;
      v_plano := v_plano || jsonb_build_object('acordo', r.acordo_id, 'aluno', r.aluno_id, 'de_parcela', r.numero, 'para_parcela', v_alvo_num, 'venc_destino', v_alvo_venc, 'pago_em', r.pago_em::date, 'valor', r.valor,
                                               'resultado', case when v_alvo = r.parcela_origem then 'ja estava certa' when r.venc_extrato is not null then 'movida (vencimento do extrato)' else 'movida (mais antiga aberta)' end);
    end loop;

    -- 6. Recalculo dos alunos.
    perform public.recalcular_situacao_aluno(x.aluno_id, 'reparo_baixa_documento')
       from (select distinct aluno_id from _rep_acordos) x;

    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (coalesce(nullif(auth.email(),''),'rotina'), 'REPARO_BAIXA_DOCUMENTO', 'parcelas', null,
            jsonb_build_object('lote', v_lote, 'acordos', v_acordos, 'reaplicadas', v_reaplicadas, 'ja_no_lugar', v_no_lugar,
                               'sem_destino', v_sem_destino, 'ja_manual', v_ja_manual, 'backup', '_backup_' || v_lote));

    v_res := jsonb_build_object('modo', case when p_confirmar then 'aplicado' else 'previa' end, 'lote', v_lote,
                                'acordos', v_acordos, 'reaplicadas', v_reaplicadas, 'ja_no_lugar', v_no_lugar,
                                'sem_destino', v_sem_destino, 'ja_manual', v_ja_manual,
                                'backup', case when p_confirmar then '_backup_' || v_lote else null end,
                                'plano', v_plano);

    if not coalesce(p_confirmar, false) then
      raise exception 'PREVIA_DESFEITA' using errcode = 'P0001';
    end if;
  exception when others then
    if sqlerrm = 'PREVIA_DESFEITA' then
      return v_res;
    end if;
    raise;
  end;

  return v_res;
end;
$$;

revoke all on function public.baixa_documento_reparar(boolean) from public, anon, authenticated;
grant execute on function public.baixa_documento_reparar(boolean) to service_role;

comment on function public.baixa_documento_reparar(boolean) is
  'Reparo de 08/09/2026: desmarca as baixas automaticas dos acordos com baixa fora de ordem e reaplica cada pagamento, em ordem de data, na parcela certa (vencimento do extrato ou a aberta mais antiga com o mesmo valor). p_confirmar=false devolve o plano sem gravar.';

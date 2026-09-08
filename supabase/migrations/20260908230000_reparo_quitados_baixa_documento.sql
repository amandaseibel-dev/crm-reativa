-- Reparo dos acordos QUITADOS apoiados em baixa automatica na parcela errada.
--
-- Amanda, 08/09/2026: "quero uma revisao, estou localizando acordos que estao
-- quitados no sistema" e "tudo que estiver baixado errado precisa corrigir,
-- nao vou fazer isso na mao nao".
--
-- O reparo da tarde (baixa_documento_reparar) so olhou acordos ATIVOS. Quando
-- a baixa deslocada caiu na ULTIMA parcela, o gatilho quitou o acordo, e o
-- lote de 01/09 ("todas as parcelas ja estavam pagas") quitou outros apoiado
-- nas mesmas marcacoes. Medido em 08/09: 83 acordos quitados com sinal --
-- parcela automatica paga mais de 15 dias antes do vencimento, ou boleto cujo
-- pagamento no extrato e de OUTRO aluno (6 acordos: Samanta Dalpiaz quitada
-- com pagamento de Stefano Ribeiro, Marcelo Borba com o de Maria Eduarda
-- Garcia, Igor Matias com o de Isaac Riquelme...).
--
-- Mesma mecanica do reparo dos ativos, com tres diferencas:
--   1. universo = acordos QUITADOS pelo gatilho ou pelo lote de 01/09, com
--      pelo menos uma baixa automatica e um sinal de erro;
--   2. baixa cujo documento foi pago por outro aluno NAO e reaplicada: a
--      parcela fica aberta, o boleto sai dela (a amarracao por vencimento
--      leva o documento para o aluno certo) e o caso fica registrado;
--   3. o acordo volta a ATIVO antes da reaplicacao; se ao fim todas as
--      parcelas estiverem pagas, o gatilho o fecha de novo; se sobrar parcela
--      aberta, ele fica ATIVO com o saldo recalculado, o aluno e o caso saem
--      de quitado e a divida volta para a carteira.
--
-- p_confirmar = false roda tudo e desfaz, devolvendo o plano. true grava com
-- backup (_backup_reparo_quitados_*) e registro em auditoria.

create or replace function public.baixa_documento_reparar_quitados(p_confirmar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '600s'
as $$
declare
  v_lote text := 'reparo_quitados_' || to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  v_hoje text := to_char(current_date,'DD/MM/YYYY');
  r record; a record; v_alvo uuid; v_alvo_num int; v_alvo_venc date; v_por_venc boolean;
  v_acordos int := 0; v_reaplicadas int := 0; v_no_lugar int := 0; v_sem_destino int := 0; v_ja_manual int := 0; v_outro_aluno int := 0;
  v_reabertos int := 0; v_continuam_quitados int := 0; v_saldo numeric;
  v_plano jsonb := '[]'::jsonb; v_res jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao()
     and current_user not in ('postgres','supabase_admin') then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  -- Nome sem acento/caixa/espacos duplicados, para comparar com o extrato.
  create temp table _rq_acordos on commit drop as
  with acq as (
    select ac.id, ac.aluno_id, ac.cpf, al.nome,
           lower(regexp_replace(translate(coalesce(al.nome,''), 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g')) nome_n
      from public.acordos ac join public.alunos al on al.id = ac.aluno_id
     where upper(coalesce(ac.status,'')) = 'QUITADO' and ac.atualizado_em >= '2026-07-01'
       and (ac.motivo_ajuste ilike '%ultima parcela foi paga%' or ac.motivo_ajuste ilike '%todas as parcelas%')
  ), auto as (
    select q.id acordo_id, q.aluno_id, q.nome_n, p.id parcela_id, p.vencimento, p.pago_em::date dt, p.boleto,
           (select g.aluno_nome from public.pagamentos g where ltrim(coalesce(g.numero_parcela_completo,''),'0') = p.boleto order by abs(g.data_pagamento - p.pago_em::date) limit 1) nome_doc,
           (select g.aluno_id from public.pagamentos g where ltrim(coalesce(g.numero_parcela_completo,''),'0') = p.boleto order by abs(g.data_pagamento - p.pago_em::date) limit 1) aluno_doc,
           (select public.vencimento_do_pagamento(g.dados) from public.pagamentos g where ltrim(coalesce(g.numero_parcela_completo,''),'0') = p.boleto and g.data_pagamento = p.pago_em::date limit 1) venc_extrato
      from acq q join public.parcelas p on p.acordo_id = q.id and p.status = 'PAGO'
     where (p.observacao ilike '%pelo documento%' or p.observacao ilike '%baixa automatica%')
  )
  select acordo_id, aluno_id
    from auto
   group by acordo_id, aluno_id
  having bool_or(dt < vencimento - 15)
      or bool_or(nome_doc is not null
                 and lower(regexp_replace(translate(nome_doc, 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g')) <> nome_n
                 and (aluno_doc is null or aluno_doc <> aluno_id))
      or bool_or(venc_extrato is not null and abs(venc_extrato - vencimento) > 3);

  select count(*) into v_acordos from _rq_acordos;

  create temp table _rq_pag on commit drop as
  select p.id parcela_origem, p.acordo_id, ra.aluno_id, p.numero, p.vencimento, p.valor, p.pago_em,
         p.confirmado_por_email, p.honorarios, p.boleto,
         (select public.vencimento_do_pagamento(g.dados) from public.pagamentos g
           where ltrim(coalesce(g.numero_parcela_completo,''),'0') = p.boleto and g.data_pagamento = p.pago_em::date limit 1) venc_extrato,
         exists (select 1 from public.baixas_pagamento b
                  where b.aluno_id = ra.aluno_id::text and b.data_pagamento = p.pago_em::date
                    and b.status_baixa = 'REALIZADA' and coalesce(b.baixado_por_email,'') <> 'rotina@sistema'
                    and (b.parcela_id is null or b.parcela_id <> p.id)
                    and abs(coalesce(b.valor_pago,0) - p.valor) <= p.valor * 0.15) ja_manual,
         (select g.aluno_nome from public.pagamentos g where ltrim(coalesce(g.numero_parcela_completo,''),'0') = p.boleto order by abs(g.data_pagamento - p.pago_em::date) limit 1) nome_doc,
         (select g.aluno_id from public.pagamentos g where ltrim(coalesce(g.numero_parcela_completo,''),'0') = p.boleto order by abs(g.data_pagamento - p.pago_em::date) limit 1) aluno_doc
    from public.parcelas p join _rq_acordos ra on ra.acordo_id = p.acordo_id
   where p.status = 'PAGO'
     and (p.observacao ilike '%pelo documento%' or p.observacao ilike '%baixa automatica%');

  begin
    execute format('create table public.%I as select p.*, now() salvo_em from public.parcelas p where p.acordo_id in (select acordo_id from _rq_acordos)', '_backup_' || v_lote);
    execute format('alter table public.%I enable row level security', '_backup_' || v_lote);
    execute format('create table public.%I as select a.*, now() salvo_em from public.acordos a where a.id in (select acordo_id from _rq_acordos)', '_backup_' || v_lote || '_acordos');
    execute format('alter table public.%I enable row level security', '_backup_' || v_lote || '_acordos');

    -- 1. Acordo volta a ATIVO antes de mexer nas parcelas: assim os gatilhos
    --    de reabertura enxergam a divida viva, e o de fechamento decide no fim.
    update public.acordos ac
       set status = 'ATIVO', atualizado_em = now(),
           motivo_ajuste = coalesce(ac.motivo_ajuste,'') || ' | reparo ' || v_hoje || ': quitacao apoiada em baixa automatica na parcela errada, pagamentos reaplicados'
      from _rq_acordos ra where ac.id = ra.acordo_id;

    -- 2. Desmarca as baixas automaticas.
    update public.parcelas p
       set status = case when p.vencimento < current_date then 'VENCIDA' else 'A_VENCER' end,
           pago_em = null, confirmado_por_email = null, boleto = null,
           observacao = coalesce(p.observacao,'') || ' | reparo ' || v_hoje || ': baixa automatica reaplicada na parcela certa',
           atualizado_em = now()
      from _rq_pag rp where p.id = rp.parcela_origem;

    -- 3. Reaplica em ordem de data.
    for r in select * from _rq_pag order by acordo_id, pago_em, numero loop
      v_alvo := null; v_por_venc := false;

      if r.nome_doc is not null
         and lower(regexp_replace(translate(r.nome_doc, 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g'))
             <> (select lower(regexp_replace(translate(coalesce(al.nome,''), 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'), '\s+', ' ', 'g')) from public.alunos al where al.id = r.aluno_id)
         and (r.aluno_doc is null or r.aluno_doc <> r.aluno_id) then
        v_outro_aluno := v_outro_aluno + 1;
        update public.parcelas set observacao = coalesce(observacao,'') || ' | reparo ' || v_hoje || ': documento ' || coalesce(r.boleto,'?') || ' foi pago por ' || r.nome_doc || ', nao por este aluno; baixa desfeita'
         where id = r.parcela_origem;
        update public.baixas_pagamento set status_baixa = 'DEVOLVIDA', devolvido_em = now(), devolvido_por_email = 'reparo@sistema',
               motivo_devolucao = 'Reparo ' || v_hoje || ': documento ' || coalesce(r.boleto,'?') || ' e de outro aluno (' || r.nome_doc || ')'
         where parcela_id = r.parcela_origem and coalesce(status_baixa,'') <> 'DEVOLVIDA';
        v_plano := v_plano || jsonb_build_object('acordo', r.acordo_id, 'aluno', r.aluno_id, 'de_parcela', r.numero, 'pago_em', r.pago_em::date, 'valor', r.valor, 'resultado', 'documento pago por outro aluno (' || r.nome_doc || '): fica aberta');
        continue;
      end if;

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
        v_por_venc := v_alvo is not null;
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
                          || case when v_por_venc then ', vencimento ' || to_char(r.venc_extrato,'DD/MM/YYYY') || ' conferido no extrato' else ', parcela aberta mais antiga' end,
             atualizado_em = now()
       where id = v_alvo;

      update public.baixas_pagamento set parcela_id = v_alvo, atualizado_em = now() where parcela_id = r.parcela_origem;

      if v_alvo = r.parcela_origem then v_no_lugar := v_no_lugar + 1; else v_reaplicadas := v_reaplicadas + 1; end if;
      v_plano := v_plano || jsonb_build_object('acordo', r.acordo_id, 'aluno', r.aluno_id, 'de_parcela', r.numero, 'para_parcela', v_alvo_num, 'venc_destino', v_alvo_venc, 'pago_em', r.pago_em::date, 'valor', r.valor,
                                               'resultado', case when v_alvo = r.parcela_origem then 'ja estava certa' when v_por_venc then 'movida (vencimento do extrato)' else 'movida (mais antiga aberta)' end);
    end loop;

    -- 4. Fecho: acordo com tudo pago ja foi refechado pelo gatilho; o que
    --    sobrou aberto fica ATIVO com saldo, e aluno/caso voltam a cobrar.
    for a in select ra.acordo_id, ra.aluno_id from _rq_acordos ra loop
      select coalesce(sum(valor),0) into v_saldo from public.parcelas where acordo_id = a.acordo_id and status in ('VENCIDA','A_VENCER');
      if v_saldo > 0.005 then
        v_reabertos := v_reabertos + 1;
        update public.acordos set status = 'ATIVO', saldo = v_saldo, atualizado_em = now() where id = a.acordo_id;
        update public.alunos
           set status_atual = 'ACORDO_FECHADO', status_jornada = 'ACORDO_FECHADO', status_acionamento = 'ACORDO_FECHADO'
         where id = a.aluno_id
           and (upper(coalesce(status_jornada,'')) like 'QUIT%' or upper(coalesce(status_jornada,'')) in ('BAIXA_REALIZADA','AGUARDANDO_BAIXA','SALDO_ZERO_CONFIRMADO','SEM_SALDO_EM_ABERTO'));
        update public.casos
           set quitado_em = null, status_financeiro = null, origem_quitacao = null, valor_quitado = null,
               status_atual = case when upper(coalesce(status_atual,'')) like 'QUIT%' then 'ACORDO_FECHADO' else status_atual end,
               caso_atualizado_por = 'reparo_quitados', caso_atualizado_em = now()
         where aluno_id = a.aluno_id and quitado_em is not null;
        update public.carteira_operador set status = 'ativo', saiu_em = null where aluno_id = a.aluno_id and status = 'quitado_saiu';
        insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
        values (a.aluno_id::text, 'REABERTURA_DIVIDA_NOVA',
                'Acordo reaberto no reparo de ' || v_hoje || ': a quitacao se apoiava em baixa automatica na parcela errada. Saldo em aberto: R$ ' || to_char(v_saldo,'FM999G999G990D00'),
                'ACORDO_FECHADO', 'SISTEMA', 'reparo@sistema', now());
      else
        v_continuam_quitados := v_continuam_quitados + 1;
        update public.acordos set status = 'QUITADO', saldo = 0, atualizado_em = now() where id = a.acordo_id and upper(coalesce(status,'')) <> 'QUITADO';
      end if;
    end loop;

    perform public.recalcular_situacao_aluno(x.aluno_id, 'reparo_quitados') from (select distinct aluno_id from _rq_acordos) x;

    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (coalesce(nullif(auth.email(),''),'rotina'), 'REPARO_QUITADOS_BAIXA_DOCUMENTO', 'acordos', null,
            jsonb_build_object('lote', v_lote, 'acordos', v_acordos, 'reaplicadas', v_reaplicadas, 'ja_no_lugar', v_no_lugar,
                               'sem_destino', v_sem_destino, 'ja_manual', v_ja_manual, 'outro_aluno', v_outro_aluno,
                               'reabertos', v_reabertos, 'continuam_quitados', v_continuam_quitados, 'backup', '_backup_' || v_lote));

    v_res := jsonb_build_object('modo', case when p_confirmar then 'aplicado' else 'previa' end, 'lote', v_lote,
                                'acordos', v_acordos, 'reaplicadas', v_reaplicadas, 'ja_no_lugar', v_no_lugar,
                                'sem_destino', v_sem_destino, 'ja_manual', v_ja_manual, 'outro_aluno', v_outro_aluno,
                                'reabertos', v_reabertos, 'continuam_quitados', v_continuam_quitados,
                                'backup', case when p_confirmar then '_backup_' || v_lote else null end, 'plano', v_plano);

    if not coalesce(p_confirmar, false) then
      raise exception 'PREVIA_DESFEITA' using errcode = 'P0001';
    end if;
  exception when others then
    if sqlerrm = 'PREVIA_DESFEITA' then return v_res; end if;
    raise;
  end;

  return v_res;
end;
$$;

revoke all on function public.baixa_documento_reparar_quitados(boolean) from public, anon, authenticated;
grant execute on function public.baixa_documento_reparar_quitados(boolean) to service_role;

comment on function public.baixa_documento_reparar_quitados(boolean) is
  'Reparo de 08/09/2026: acordos QUITADOS (gatilho ou lote de 01/09) apoiados em baixa automatica na parcela errada; reaplica os pagamentos, desfaz baixa com documento de outro aluno e reabre o acordo se sobrar parcela. p_confirmar=false devolve o plano sem gravar.';

-- ROLLBACK de 20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade (versao em producao 20260925123852).
--
-- Devolve titulo_reavaliar e cancelar_acordo_ficha aos corpos de producao de
-- 22/09/2026 (20260922265000, versao 20260922181141), copiados byte a byte
-- daquela migration: md5(prosrc) 5704f3aa88cbd1856480dbefac3f9807 e
-- 6cc366f032b76fa9e0fca15d08db9964. Depois dele, mensalidade de acordo
-- cancelado volta a ficar NEGOCIADA em qualquer caso.
--
-- NAO desfaz dado: mensalidade que ja voltou para ABERTO continua ABERTO. A
-- volta das 19 corrigidas em lote tem rollback proprio, por id, a partir da
-- tabela de backup daquela correcao.

CREATE OR REPLACE FUNCTION public.titulo_reavaliar(p_titulo uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_situacao text; v_status text; v_acordo_atual uuid;
  v_acordo uuid; v_status_acordo text; v_numero text; v_quitado boolean;
  v_acordo_bloqueio uuid; v_status_bloqueio text;
begin
  select situacao, status, acordo_id into v_situacao, v_status, v_acordo_atual
    from public.acordos_titulos where id = p_titulo;
  if not found then return; end if;

  -- Ja paga: nada aqui reabre mensalidade quitada.
  if upper(coalesce(v_situacao,'')) = 'PAGO'
     or lower(coalesce(v_status,'')) in ('quitada','paga') then
    return;
  end if;

  -- Ja cancelada: nada aqui ressuscita titulo cancelado. Cancelar e uma decisao
  -- deliberada (rotina ou gestao); a reavaliacao automatica nao desfaz decisao.
  -- Voltar a cobrar exige um caminho explicito, que hoje nao existe -- e quando
  -- existir sera um "desfazer" com registro, nao um efeito colateral daqui.
  if upper(coalesce(v_situacao,'')) = 'CANCELADA'
     or lower(coalesce(v_status,'')) = 'cancelada' then
    return;
  end if;

  select v.acordo_id, upper(coalesce(a.status,'')), coalesce(a.numero_acordo::text,'')
    into v_acordo, v_status_acordo, v_numero
    from public.acordo_titulo_vinculo v
    join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = p_titulo
     and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   order by v.criado_em desc nulls last
   limit 1;

  -- Mensalidade NEGOCIADA cujo acordo caiu (CANCELADO/QUEBRADO/INATIVO): o
  -- cancelamento e uma mudanca de estado do ACORDO, nao uma decisao sobre a
  -- mensalidade original. A negociacao fica preservada no historico -- a
  -- reavaliacao automatica nao desfaz retroativamente o que foi negociado, nem
  -- soma de novo o valor como mensalidade em aberto. So entra aqui quando a
  -- situacao ATUAL do titulo ja e NEGOCIADO: se nunca foi negociado, ou se o
  -- motivo de nao achar vinculo vivo e outro, o caminho de baixo decide, como
  -- sempre decidiu.
  if v_acordo is null and upper(coalesce(v_situacao,'')) = 'NEGOCIADO' then
    select coalesce(
        (select v.acordo_id from public.acordo_titulo_vinculo v
          where v.titulo_id = p_titulo
          order by v.criado_em desc nulls last limit 1),
        v_acordo_atual)
      into v_acordo_bloqueio;

    if v_acordo_bloqueio is not null then
      select upper(coalesce(status,'')) into v_status_bloqueio
        from public.acordos where id = v_acordo_bloqueio;
    end if;

    if v_status_bloqueio in ('CANCELADO','CANCELADA','QUEBRADO','INATIVO') then
      return;
    end if;
  end if;

  -- Sem acordo vivo: a divida volta a ser cobrada. O vinculo continua na
  -- tabela, entao a composicao do acordo nao se perde -- ver a tela do acordo.
  if v_acordo is null then
    update public.acordos_titulos
       set situacao = 'ABERTO', status = 'em_aberto',
           acordo_id = null, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'ABERTO'
            or coalesce(status,'') <> 'em_aberto'
            or acordo_id is not null);
    return;
  end if;

  -- Quitado de verdade e acordo sem parcela viva. Acordo marcado QUITADO com
  -- parcela em aberto nao quita mensalidade nenhuma (guarda de 20260831140000).
  -- RENEGOCIADA nao entra aqui: parcela renegociada nao e parcela paga.
  v_quitado := v_status_acordo = 'QUITADO'
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','RENEGOCIADA'));

  if v_quitado then
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada', acordo_id = v_acordo,
           motivo_ajuste = coalesce(motivo_ajuste,'')
             || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
             || 'quitada junto com o acordo ' || v_numero
             || ': a divida desta mensalidade foi negociada nele e o acordo foi pago',
           atualizado_em = now()
     where id = p_titulo;
  else
    update public.acordos_titulos
       set situacao = 'NEGOCIADO', status = 'vinculada',
           acordo_id = v_acordo, atualizado_em = now()
     where id = p_titulo
       and (coalesce(situacao,'') <> 'NEGOCIADO'
            or coalesce(status,'') <> 'vinculada'
            or acordo_id is distinct from v_acordo);
  end if;
end;
$function$;

comment on function public.titulo_reavaliar(uuid) is
  'Reavalia um titulo contra o acordo vivo dele. PAGO/quitada e CANCELADA/cancelada sao estados terminais. Mensalidade NEGOCIADA cujo acordo caiu (CANCELADO/CANCELADA/QUEBRADO/INATIVO) tambem nao e reaberta: fica NEGOCIADA no historico (regra de 22/09/2026, reverte a de 09/09).';

CREATE OR REPLACE FUNCTION public.cancelar_acordo_ficha(p_acordo_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
declare
  v_agora    timestamptz := now();
  v_acordo   public.acordos%rowtype;
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

  if exists (select 1 from public.parcelas where acordo_id = p_acordo_id and upper(coalesce(status, '')) = 'PAGO') then
    raise exception 'Esse acordo ja tem parcela paga -- nao da pra cancelar (protege o historico financeiro). Se foi um erro, fale com quem confirmou o pagamento antes de mexer.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.baixas_pagamento where acordo_id = p_acordo_id and devolvido_em is null) then
    raise exception 'Esse acordo ja tem alguma baixa/pagamento registrado -- nao da pra cancelar por aqui.' using errcode = 'P0001';
  end if;

  -- As mensalidades negociadas NAO voltam para ABERTO aqui: cancelar o acordo
  -- muda o estado do ACORDO, nao desfaz a negociacao das mensalidades
  -- originais. Por isso o status do acordo muda PRIMEIRO -- e' o gatilho desse
  -- UPDATE (trg_acordo_status_reavalia_titulos -> titulo_reavaliar) que decide
  -- o destino de cada titulo, e ele precisa ver o acordo ja CANCELADO. So
  -- depois o vinculo e' desativado -- nunca apagado -- para a cadeia
  -- mensalidade->negociacao->acordo continuar inteira na tela e na auditoria.
  update public.acordos
     set status = 'CANCELADO', saldo = 0, atualizado_em = v_agora
   where id = p_acordo_id;

  update public.acordo_titulo_vinculo
     set ativo = false
   where acordo_id = p_acordo_id and coalesce(ativo, true);
  get diagnostics v_vinculos = row_count;

  update public.parcelas
     set status = 'CANCELADA', atualizado_em = v_agora
   where acordo_id = p_acordo_id
     and upper(coalesce(status, '')) <> 'PAGO';
  get diagnostics v_parcelas = row_count;

  if v_acordo.aluno_id is not null then
    perform public.liberar_caso_por_evento(v_acordo.aluno_id, 'CANCELADO');
  end if;

  return jsonb_build_object(
    'ok', true,
    'acordo_id', p_acordo_id,
    'vinculos_desativados', v_vinculos,
    'parcelas_canceladas', v_parcelas
  );
end;
$function$;

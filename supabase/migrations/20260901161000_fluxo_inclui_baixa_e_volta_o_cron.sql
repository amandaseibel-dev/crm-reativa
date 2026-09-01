-- A rotina que baixa lendo o numero no relatorio de pagamento entra no fluxo
-- horario, como rede: o gatilho de importacao ja baixa na hora, mas pagamento
-- que chegou antes da rotina existir, ou que so ficou casavel depois (o acordo
-- entrou depois do pagamento), fica para o cron pegar.
--
-- O cron do fluxo tinha sido removido em 31/08 e nunca religado -- por isso
-- nada rodava de hora em hora. Volta aqui, aos :40.

insert into public.fluxo_pagamentos_config (etapa, ligado, observacao) values
  ('baixa_pelo_relatorio', true,
   'le o numero do documento no pagamento, grava na parcela e baixa -- so quando o valor bate e o acordo esta ATIVO')
on conflict (etapa) do update set ligado = true,
  observacao = excluded.observacao, alterado_em = now();

create or replace function public.fluxo_pagamentos_rodar(p_origem text default 'cron')
returns jsonb language plpgsql security definer
set search_path to 'public' set statement_timeout to '900s'
as $function$
declare
  v_antes numeric; v_depois numeric; v_res jsonb := '{}'::jsonb;
  v_liga boolean; v_carga jsonb; v_erro text;
begin
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
    values (p_origem, jsonb_build_object('pulou','sistema sob carga'));
    return jsonb_build_object('pulou','sistema sob carga');
  end if;

  perform set_config('reativa.fluxo_pagamentos','on', true);
  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  begin
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='amarrar_boleto';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('amarrar_boleto', public.parcelas_amarrar_boleto());
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='pos_importacao';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('pos_importacao', public.acordos_pos_importacao(null, true));
    end if;

    -- le o numero no pagamento, grava na parcela e baixa
    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_pelo_relatorio';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa_pelo_relatorio',
                 public.baixa_pelo_relatorio_pagamento(true, (current_date - 180)));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='baixa_por_documento';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('baixa', public.baixa_por_documento_aplicar('2026-07-01', true));
    else
      v_res := v_res || jsonb_build_object('baixa_previa', public.baixa_por_documento_aplicar('2026-07-01', false));
    end if;

    select ligado into v_liga from public.fluxo_pagamentos_config where etapa='sinalizar_duplicado';
    if coalesce(v_liga,false) then
      v_res := v_res || jsonb_build_object('duplicados', public.acordos_sinalizar_boleto_repetido());
    end if;
  exception when others then
    v_erro := SQLERRM;
  end;

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;
  insert into public.fluxo_pagamentos_execucoes (origem, carteira_antes, carteira_depois, resultado, erro)
  values (p_origem, v_antes, v_depois, v_res, v_erro);

  return jsonb_build_object('carteira_antes',v_antes,'carteira_depois',v_depois,
                            'variacao', round(v_depois-v_antes,2), 'etapas', v_res, 'erro', v_erro);
end;
$function$;

revoke all on function public.fluxo_pagamentos_rodar(text) from public, anon;
grant execute on function public.fluxo_pagamentos_rodar(text) to authenticated, service_role;

do $$
begin
  perform cron.unschedule('fluxo_pagamentos_horario');
exception when others then null;
end $$;
select cron.schedule('fluxo_pagamentos_horario', '40 * * * *',
  $cron$select public.fluxo_pagamentos_rodar('cron')$cron$);

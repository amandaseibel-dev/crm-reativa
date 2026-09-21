-- ROLLBACK de 20260922160000: volta confirmacao_encerrar_uma ao texto de 20260922100200 (encerra tambem no saldo zero).
begin;
CREATE OR REPLACE FUNCTION public.confirmacao_encerrar_uma(p_confirmacao_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_p jsonb; v_res jsonb; v_old_f text := current_setting('reativa.fluxo_pagamentos', true); v_old_a text := current_setting('reativa.confirmacao_auto', true);
begin
  v_p := public.confirmacao_pagamento_processado(p_confirmacao_id);
  if v_p->>'estado' is distinct from 'PROCESSADO' or v_p->>'prova' not in ('VINCULO_GRAVADO','CHAVE_MESMA_TRANSACAO') then
    return jsonb_build_object('encerrou', false, 'estado', v_p->>'estado', 'motivo', v_p->>'motivo');
  end if;
  perform set_config('reativa.fluxo_pagamentos', 'on', true);
  perform set_config('reativa.confirmacao_auto', 'on', true);
  v_res := public.confirmar_pagamento_solicitacao(p_confirmacao_id, null);
  perform set_config('reativa.fluxo_pagamentos', coalesce(v_old_f, ''), true);
  perform set_config('reativa.confirmacao_auto', coalesce(v_old_a, ''), true);
  return jsonb_build_object('encerrou', coalesce((v_res->>'ja_processado')::boolean, false) = false, 'resultado', v_res);
end;
$function$;
commit;

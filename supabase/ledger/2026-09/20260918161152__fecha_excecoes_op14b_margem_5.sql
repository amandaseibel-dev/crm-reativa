-- FECHAMENTO DAS EXCECOES HUMANAS -- 18/09/2026 -- OPERACAO 14b -- margem excepcional (repeticao com o sub da gestao)
-- Autorizado pela Amanda em 18/09/2026, INDIVIDUALMENTE. Os 5 pagamentos A/B cujas
-- mensalidades continuam em aberto (os outros 5 entraram na Conferencia Prime do
-- Grupo A as 15:43 e nao sao tocados). Para cada um, numa subtransacao propria:
-- autorizacao da gestao (pagamento_autorizar_margem_excepcional recalcula aluno,
-- CPF, mensalidades, honorario 8%, base e Prime), registrador oficial do acordo a
-- vista e validacao da cadeia. Falhou um: so aquele volta.
do $op$
declare
  r record; v_a jsonb; v_p jsonb; v_ids uuid[]; v_reg jsonb; v_acordo uuid; v_res jsonb := '[]'::jsonb;
begin
  for r in select p.id, ltrim(p.numero_parcela_completo,'0') bol from public.pagamentos p
            where ltrim(p.numero_parcela_completo,'0') in ('50717700001','50719070001','50719480001','50719550001','50721580001')
            order by 2 loop
    begin
      perform set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated","sub":"52b292e4-e43e-4200-a684-b63d889d273a"}', true);
      v_a := public.pagamento_autorizar_margem_excepcional(r.id,
        'Autorizado pela Amanda em 18/09/2026 (classe A/B): base entre o valor das mensalidades e o corrigido do Prime.');
      if not coalesce((v_a->>'ok')::boolean,false) then raise exception 'AUTORIZACAO_RECUSADA %', v_a; end if;
      v_p := public.acordo_avista_previa(r.id, null);
      if not coalesce((v_p->>'aprovado')::boolean,false) then raise exception 'PREVIA_RECUSOU %', v_p->'bloqueios'; end if;
      select array_agg((t->>'id')::uuid) into v_ids from jsonb_array_elements(v_p->'titulos'->'selecionados') t where t->>'impedimento' is null;
      v_reg := public.acordo_avista_registrar(r.id, v_ids, true);
      perform set_config('request.jwt.claims', '', true);
      if not coalesce((v_reg->>'gravou')::boolean,false) then raise exception 'REGISTRADOR_RECUSOU %', v_reg->'bloqueios'; end if;
      v_acordo := (v_reg->>'acordo_id')::uuid;
      -- validacao da cadeia
      if (select status_conciliacao from public.pagamentos where id = r.id) <> 'BAIXADO'
         or (select upper(status) from public.acordos where id = v_acordo) <> 'QUITADO'
         or (select count(*) from public.parcelas where origem_baixa_ref = r.id::text) <> 1
         or not exists (select 1 from public.parcelas where acordo_id = v_acordo and upper(status) = 'PAGO' and origem_baixa_ref = r.id::text)
         or exists (select 1 from unnest(v_ids) x join public.acordos_titulos t on t.id = x
                     where upper(t.situacao) <> 'PAGO' or t.acordo_id is distinct from v_acordo
                        or (select count(*) from public.acordo_titulo_vinculo v where v.titulo_id = t.id and coalesce(v.ativo,true)) <> 1
                        or (select count(*) from public.acordo_titulo_vinculo v where v.titulo_id = t.id and v.acordo_id = v_acordo and v.ativo) <> 1)
         or (select usado_em is null from public.pagamento_margem_autorizada where pagamento_id = r.id) then
        raise exception 'CADEIA_NAO_FECHOU';
      end if;
      v_res := v_res || jsonb_build_array(jsonb_build_object('boleto', r.bol, 'resultado', 'BAIXADO', 'acordo_id', v_acordo,
                                                             'base', v_a->'base', 'prime', v_a->'valor_prime', 'titulos', cardinality(v_ids)));
    exception when others then
      perform set_config('request.jwt.claims', '', true);
      v_res := v_res || jsonb_build_array(jsonb_build_object('boleto', r.bol, 'resultado', 'NAO_EXECUTADO', 'motivo', sqlerrm));
    end;
  end loop;
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('fechamento_pagamentos_20260918', 'MARGEM_EXCEPCIONAL_LOTE', 'pagamentos', null,
          jsonb_build_object('op', 14, 'resultados', v_res,
                             'fora_por_grupo_a', jsonb_build_array('50716450001','50716720001','50717060001','50717460001','50717870001')));
end
$op$;
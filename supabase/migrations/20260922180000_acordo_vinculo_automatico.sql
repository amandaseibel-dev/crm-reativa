-- VINCULO AUTOMATICO DOS ACORDOS COM SUGESTAO FORTE (PR #448 ja classifica; aqui o sistema efetiva sozinho).
-- Nao faz vinculo financeiro no DDL: instala a funcao e o job. O estoque e processado pelo proprio job, em lotes, nas proximas rodadas.
-- Sem segunda logica de vinculo: recalcula com acordo_vinculo_sugestoes_calcular e efetiva SOMENTE via vincular_titulos_acordo.
-- REVISAO / SEM_EVIDENCIA nunca vinculam. Composicao REJEITADA pela gestao (mesmo hash) nunca vincula.
-- Acordo ja vinculado sai sozinho do conjunto elegivel do calculo (idempotente); a cada rodada so reavalia quem continua sem vinculo.
-- Job a cada 15 min (:00/:15/:30/:45) -- nunca :40 (rodada horaria fluxo_pagamentos_horario, que nao e tocada).
begin;

create or replace function public.acordo_vinculo_automatico_processar(p_limite int default 40)
 returns jsonb language plpgsql security definer set search_path to 'public' set statement_timeout to '120s'
as $function$
#variable_conflict use_column
declare
  c record; s record; v_ids uuid[]; v_res jsonb;
  v_ator constant text := 'vinculo-automatico@sistema';
  v_claims_antes text := current_setting('request.jwt.claims', true);
  v_ok int := 0; v_falha int := 0; v_pulados int := 0; v_lim int := greatest(coalesce(p_limite, 40), 1);
begin
  if not pg_try_advisory_xact_lock(hashtext('acordo_vinculo_automatico_processar')) then
    return jsonb_build_object('ok', true, 'pulou', 'EM_EXECUCAO');
  end if;
  if coalesce((public.sistema_sob_carga() ->> 'sob_carga')::boolean, false) then
    return jsonb_build_object('ok', true, 'pulou', 'SOB_CARGA');
  end if;
  -- identidade de sistema para a RPC oficial (ela exige auth.email() nao vazio); vale so nesta transacao
  perform set_config('request.jwt.claims', jsonb_build_object('email', v_ator, 'role', 'service_role')::text, true);

  for c in
    select x.acordo_id, x.composicao_hash
      from public.acordo_vinculo_sugestoes_calcular(null) x
     where x.nivel = 'FORTE'
       and not exists (select 1 from public.acordo_vinculo_sugestao_decisao d
                        where d.acordo_id = x.acordo_id and d.composicao_hash = x.composicao_hash and d.decisao = 'REJEITADA')
     order by x.acordo_id
     limit v_lim
  loop
    begin
      -- 1) recalcula agora; 2) continua FORTE, mesma composicao e nao rejeitada
      select * into s from public.acordo_vinculo_sugestoes_calcular(c.acordo_id);
      if not found or s.nivel <> 'FORTE' or s.composicao_hash is distinct from c.composicao_hash
         or exists (select 1 from public.acordo_vinculo_sugestao_decisao d
                     where d.acordo_id = c.acordo_id and d.composicao_hash = s.composicao_hash and d.decisao = 'REJEITADA') then
        v_pulados := v_pulados + 1; continue;
      end if;
      select array_agg((t->>'titulo_id')::uuid order by (t->>'titulo_id')::uuid) into v_ids from jsonb_array_elements(s.titulos) t;
      -- 3) guardas + 4) efetivacao: somente a RPC oficial. Recusa => desfaz o sub-bloco inteiro, sem vinculo parcial.
      v_res := public.vincular_titulos_acordo(v_ids, c.acordo_id);
      if not coalesce((v_res->>'ok')::boolean, false) then
        raise exception 'VINCULO_RECUSADO %', v_res::text;
      end if;
      -- 5) auditoria + 6) caso resolvido (decisao CONFIRMADA por sistema)
      insert into public.acordo_vinculo_sugestao_decisao (acordo_id, composicao_hash, titulo_ids, decisao, nivel, motivo, decidido_por)
      values (c.acordo_id, s.composicao_hash, v_ids, 'CONFIRMADA', s.nivel, s.motivo, v_ator);
      insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
      values (v_ator, 'SUGESTAO_VINCULO_AUTOMATICO', 'acordos', c.acordo_id,
              jsonb_build_object('composicao_hash', s.composicao_hash, 'titulo_ids', v_ids, 'motivo', s.motivo, 'liquidacao_195', s.liquidacao_195));
      v_ok := v_ok + 1;
    exception when others then
      v_falha := v_falha + 1;
      begin
        insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
        values (v_ator, 'SUGESTAO_VINCULO_AUTOMATICO_FALHA', 'acordos', c.acordo_id, jsonb_build_object('erro', left(sqlerrm, 500)));
      exception when others then null; end;
    end;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_claims_antes, ''), true);
  return jsonb_build_object('ok', true, 'vinculados', v_ok, 'falhas', v_falha, 'pulados', v_pulados, 'limite', v_lim);
end;
$function$;

revoke all on function public.acordo_vinculo_automatico_processar(int) from public, anon, authenticated;
grant execute on function public.acordo_vinculo_automatico_processar(int) to service_role;

select cron.schedule('acordo_vinculo_automatico', '0,15,30,45 * * * *',
  $cron$select public.acordo_vinculo_automatico_processar(40);$cron$);

commit;

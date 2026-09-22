-- BACKFILL PONTUAL: pagamentos legados (anteriores ao motor de conciliacao) cuja parcela ja existia,
-- casava por boleto e nunca foram avaliados -- porque o unico jeito de entrar no motor e o trigger de
-- INSERT (trg_pagamento_conciliar -> _pagamento_conciliar() -> pagamento_conciliar_um(id, true)), e essas
-- linhas foram inseridas antes do motor existir.
--
-- ESCOPO FECHADO: so os pagamentos passados em p_ids. NAO ha segunda regra de match nem segunda logica de
-- baixa: a unica funcao que decide e escreve e a oficial public.pagamento_conciliar_um(uuid, boolean),
-- ja usada pelo trigger de producao e por outras rotinas do motor. Este backfill so a CHAMA, uma vez por
-- pagamento, com o mesmo contrato (p_aplicar => true grava; ela mesma reavalia tudo, tem lock e releitura
-- antes de escrever, e e idempotente por desenho -- reprocessar um BAIXADO so confirma o proprio estado).
begin;

create or replace function public._backfill_57_conciliacao_legado(p_ids uuid[])
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_res jsonb;
  v_processados int := 0;
  v_baixados int := 0;
  v_pulados int := 0;
  v_falhas int := 0;
  v_detalhes jsonb := '[]'::jsonb;
begin
  foreach v_id in array coalesce(p_ids, '{}'::uuid[])
  loop
    begin
      -- reavaliacao fresca no momento da execucao -- nao confia no diagnostico antigo
      if not exists (select 1 from public.pagamentos p where p.id = v_id
                       and p.status_conciliacao is null and p.origem_vinculo is null) then
        v_pulados := v_pulados + 1;
        v_detalhes := v_detalhes || jsonb_build_object('pagamento_id', v_id, 'pulado', 'STATUS_JA_MUDOU');
        continue;
      end if;

      -- a propria funcao oficial reavalia parcela/acordo/valor/documento; so filtramos aqui o que o
      -- diagnostico pediu (acordo ATIVO) para nao gastar a chamada com casos ja fora do escopo
      if not exists (
        select 1 from public.pagamentos p
          join public.parcelas pr on pr.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
          join public.acordos a on a.id = pr.acordo_id
         where p.id = v_id and upper(coalesce(pr.status,'')) <> 'PAGO' and upper(coalesce(a.status,'')) = 'ATIVO'
      ) then
        v_pulados := v_pulados + 1;
        v_detalhes := v_detalhes || jsonb_build_object('pagamento_id', v_id, 'pulado', 'FORA_DO_CRITERIO_NO_MOMENTO_DA_EXECUCAO');
        continue;
      end if;

      v_res := public.pagamento_conciliar_um(v_id, true);
      v_processados := v_processados + 1;
      if (v_res->>'status') = 'BAIXADO' then v_baixados := v_baixados + 1; end if;
      v_detalhes := v_detalhes || jsonb_build_object('pagamento_id', v_id, 'resultado', v_res->>'status', 'motivo', v_res->>'motivo');
    exception when others then
      v_falhas := v_falhas + 1;
      v_detalhes := v_detalhes || jsonb_build_object('pagamento_id', v_id, 'falha', left(sqlerrm, 300));
    end;
  end loop;

  return jsonb_build_object('ok', true, 'processados', v_processados, 'baixados', v_baixados,
                             'pulados', v_pulados, 'falhas', v_falhas, 'detalhes', v_detalhes);
end;
$function$;

revoke all on function public._backfill_57_conciliacao_legado(uuid[]) from public, anon, authenticated;
grant execute on function public._backfill_57_conciliacao_legado(uuid[]) to service_role, postgres;

commit;

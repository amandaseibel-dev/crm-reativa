-- ROLLBACK: dre_snapshot volta ao portao compartilhado com a Visao Executiva.
-- ATENCAO: com isto cobranca04 e cobranca07 voltam a poder ler o DRE inteiro
-- (incluindo folha_detalhe, com os salarios) chamando a RPC direto.
begin;

create or replace function public.dre_snapshot(p_ano integer)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare v_payload jsonb;
begin
  if not public.snapshot_gerencial_pode_ler() then raise exception 'Sem permissão.'; end if;
  select payload into v_payload from public.snapshot_gerencial where chave='dre' and ano=p_ano;
  if v_payload is null or not (v_payload ? 'meses') then
    v_payload := public._dre_dados_calcula(p_ano);
    if v_payload ? 'meses' then
      insert into public.snapshot_gerencial(chave, ano, payload, gerado_por) values ('dre', p_ano, v_payload, 'bootstrap')
        on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
    end if;
  end if;
  return v_payload;
end; $fn$;

drop function if exists public.dre_pode_ler();
commit;

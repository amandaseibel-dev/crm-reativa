-- ROLLBACK: DRE volta ao comportamento anterior (dre_dados so da Amanda,
-- devolvendo {"erro":"sem_acesso"} para os demais, e os snapshots voltando a
-- gravar esse payload sem checar 'meses').
-- ATENCAO: com este rollback o DRE do ano corrente volta a zerar sempre que
-- alguem que nao seja a Amanda clicar "Atualizar projecao".
begin;

create or replace function public.dre_dados(p_ano integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_email text := coalesce(auth.jwt() ->> 'email','');
begin
  if v_email <> 'amanda.seibel@aelbra.com.br' then
    return jsonb_build_object('erro','sem_acesso');
  end if;
  return public._dre_dados_calcula(p_ano);
end;$$;

create or replace function public.dre_snapshot(p_ano integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_payload jsonb;
begin
  if not public.snapshot_gerencial_pode_ler() then raise exception 'Sem permissão.'; end if;
  select payload into v_payload from public.snapshot_gerencial where chave='dre' and ano=p_ano;
  if v_payload is null then
    v_payload := public.dre_dados(p_ano);
    insert into public.snapshot_gerencial(chave, ano, payload, gerado_por) values ('dre', p_ano, v_payload, 'bootstrap')
      on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
  end if;
  return v_payload;
end; $$;

create or replace function public.atualizar_snapshots_gerenciais(p_ano int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_ano int := coalesce(p_ano, extract(year from now())::int); v_email text := coalesce(auth.jwt() ->> 'email','server');
begin
  if not public.snapshot_gerencial_e_gestao() then raise exception 'Sem permissão para atualizar os snapshots gerenciais.'; end if;
  insert into public.snapshot_gerencial(chave, ano, payload, gerado_por, gerado_em)
    values ('executivo', 0, public.dashboard_executivo()::jsonb, v_email, now())
    on conflict (chave, ano) do update set payload=excluded.payload, gerado_por=excluded.gerado_por, gerado_em=now();
  insert into public.snapshot_gerencial(chave, ano, payload, gerado_por, gerado_em)
    values ('dre', v_ano, public.dre_dados(v_ano), v_email, now())
    on conflict (chave, ano) do update set payload=excluded.payload, gerado_por=excluded.gerado_por, gerado_em=now();
  return jsonb_build_object('ok', true, 'ano', v_ano, 'gerado_em', now());
end; $$;

-- _dre_dados_calcula fica: as tres funcoes acima dependem dela.
commit;

-- Desfaz 20260903400000_salarios_so_amanda: devolve as três funções ao corpo
-- que estava em produção em 03/09/2026 (antes da correção).
--
-- Cuidado: voltar isto REABRE os dois furos -- a diretoria volta a receber
-- salário base e folha por pessoa no `dre_snapshot`, e um token sem e-mail
-- volta a passar nos gates do Fechamento e de borderôs/importações.

create or replace function public.usuario_pode_acessar_fechamento_remuneracao()
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $function$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$function$;

create or replace function public.app_pode_borderos_importacoes()
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $function$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    return current_user in ('postgres','supabase_admin','service_role');
  end if;
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$function$;

create or replace function public.dre_snapshot(p_ano integer)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $function$
declare v_payload jsonb;
begin
  if not public.dre_pode_ler() then
    raise exception 'Acesso negado: o DRE e da gerencia e da diretoria.' using errcode = '42501';
  end if;
  select payload into v_payload from public.snapshot_gerencial where chave='dre' and ano=p_ano;
  if v_payload is null or not (v_payload ? 'meses') then
    v_payload := public._dre_dados_calcula(p_ano);
    if v_payload ? 'meses' then
      insert into public.snapshot_gerencial(chave, ano, payload, gerado_por) values ('dre', p_ano, v_payload, 'bootstrap')
        on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
    end if;
  end if;
  return v_payload;
end; $function$;

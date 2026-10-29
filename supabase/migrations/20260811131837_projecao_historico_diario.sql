-- Projeção Hora a Hora — histórico DIÁRIO da projeção (pra comparar "vs ontem").
--
-- Problema: projecao_snapshot faz UPSERT (só o último estado fica), então não
-- dá pra saber se a projeção de fechamento subiu ou caiu em relação a ontem.
-- Solução: uma foto por DIA dos números-chave da filial. O gancho grava sempre
-- que a gestão clica "Atualizar projeção" (upsert por dia — a última do dia
-- vence). A comparação "vs ontem" passa a existir a partir do 2º dia gravado.
--
-- Segurança: RLS deny-all (sem policies); acesso SOMENTE via RPCs SECURITY
-- DEFINER com gate de gestão real (Amanda Seibel / Fernanda = cobranca04).

create table if not exists public.projecao_historico_diario (
  mes_referencia      text        not null,
  dia                 date        not null,
  recuperado          numeric,
  honorario           numeric,
  projecao_honorario  numeric,
  meta_honorario      numeric,
  percentual_projecao numeric,
  atualizado_em       timestamptz not null default now(),
  atualizado_por      text,
  primary key (mes_referencia, dia)
);

alter table public.projecao_historico_diario enable row level security;
-- Sem policies de propósito: ninguém lê/escreve direto. Só as RPCs abaixo.

-- Grava a foto de HOJE a partir do snapshot FILIAL já calculado. Idempotente
-- no dia (upsert): reexecutar no mesmo dia só atualiza os valores.
create or replace function public.projecao_historico_diario_gravar(p_mes text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    return;
  end if;

  insert into public.projecao_historico_diario as h
    (mes_referencia, dia, recuperado, honorario, projecao_honorario, meta_honorario, percentual_projecao, atualizado_em, atualizado_por)
  select p_mes, v_hoje,
         (payload->>'recuperado_reativa_mes')::numeric,
         (payload->>'honorario_mes_filial')::numeric,
         (payload->>'projecao_honorario_filial')::numeric,
         (payload->>'meta_honorario')::numeric,
         (payload->>'percentual_projecao_filial')::numeric,
         now(), v_email
    from public.projecao_snapshot
   where mes_referencia = p_mes and escopo = 'FILIAL'
  on conflict (mes_referencia, dia) do update
    set recuperado          = excluded.recuperado,
        honorario           = excluded.honorario,
        projecao_honorario  = excluded.projecao_honorario,
        meta_honorario      = excluded.meta_honorario,
        percentual_projecao = excluded.percentual_projecao,
        atualizado_em       = excluded.atualizado_em,
        atualizado_por      = excluded.atualizado_por;
end;
$function$;

-- Lê a série diária do mês (gestão). Retorna também o delta da projeção do
-- último dia vs o penúltimo ("vs ontem") já calculado no backend.
create or replace function public.projecao_historico_diario_ler(p_mes text)
returns json
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_serie json;
  v_ultimo record;
  v_penultimo record;
begin
  if v_email not in ('amanda.seibel@aelbra.com.br','cobranca04@aelbra.com.br') then
    return json_build_object('autorizado', false);
  end if;

  select coalesce(json_agg(json_build_object(
           'dia', dia, 'recuperado', recuperado, 'honorario', honorario,
           'projecao_honorario', projecao_honorario, 'meta_honorario', meta_honorario,
           'percentual_projecao', percentual_projecao) order by dia), '[]'::json)
    into v_serie
    from public.projecao_historico_diario where mes_referencia = p_mes;

  select * into v_ultimo from public.projecao_historico_diario
   where mes_referencia = p_mes order by dia desc limit 1;
  select * into v_penultimo from public.projecao_historico_diario
   where mes_referencia = p_mes order by dia desc offset 1 limit 1;

  return json_build_object(
    'autorizado', true,
    'serie', v_serie,
    'projecao_hoje',  v_ultimo.projecao_honorario,
    'projecao_ontem', v_penultimo.projecao_honorario,
    'dia_hoje',  v_ultimo.dia,
    'dia_ontem', v_penultimo.dia,
    'delta_projecao', case
        when v_penultimo.projecao_honorario is not null and v_penultimo.projecao_honorario <> 0
        then round(((v_ultimo.projecao_honorario - v_penultimo.projecao_honorario) / v_penultimo.projecao_honorario) * 100, 1)
        else null end
  );
end;
$function$;

revoke all on function public.projecao_historico_diario_gravar(text) from public, anon, authenticated;
revoke all on function public.projecao_historico_diario_ler(text)   from public, anon, authenticated;
grant execute on function public.projecao_historico_diario_gravar(text) to authenticated;
grant execute on function public.projecao_historico_diario_ler(text)   to authenticated;

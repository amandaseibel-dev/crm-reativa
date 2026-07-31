-- =============================================================================
-- TV ReATIVA — leitura anônima (telão kiosk sem login)
-- =============================================================================
-- Incidente: o telão físico roda /tv numa sessão NÃO autenticada, então
-- tv_snapshot_ler era negado (grant/role só para authenticated) e a TV mostrava
-- "Os indicadores serão exibidos após a atualização da projeção." mesmo com o
-- snapshot pronto. O payload é LIVRE DE PII (sem CPF/telefone/nome de aluno),
-- então liberamos a LEITURA (e o sinal realtime) para o papel anon.
--
-- Continuam restritos a Amanda/Fernanda: tv_snapshot_atualizar (geração) e o
-- tv_snapshot_calcular (interno). Nada de escrita é liberado.
-- =============================================================================

-- Leitura do snapshot: qualquer papel (inclui anon do telão). Sem restrição de
-- role (a função é SECURITY DEFINER e só devolve indicadores agregados).
create or replace function public.tv_snapshot_ler()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $fn$
declare v_row public.tv_snapshot%rowtype;
begin
  select * into v_row from public.tv_snapshot where id = true;
  if not found or v_row.payload is null then
    return jsonb_build_object('status','vazio','versao',coalesce(v_row.versao,0),
      'payload',null,'gerado_em',v_row.gerado_em,'gerado_por',v_row.gerado_por,'erro_resumo',v_row.erro_resumo);
  end if;
  return jsonb_build_object('status', v_row.status, 'versao', v_row.versao, 'payload', v_row.payload,
    'gerado_em', v_row.gerado_em, 'gerado_por', v_row.gerado_por, 'duracao_ms', v_row.duracao_ms, 'erro_resumo', v_row.erro_resumo);
end;
$fn$;

create or replace function public.tv_snapshot_versao()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $fn$
declare v_versao bigint; v_gerado timestamptz;
begin
  select versao, gerado_em into v_versao, v_gerado from public.tv_snapshot where id = true;
  return jsonb_build_object('versao', coalesce(v_versao,0), 'gerado_em', v_gerado);
end;
$fn$;

grant execute on function public.tv_snapshot_ler()   to anon, authenticated;
grant execute on function public.tv_snapshot_versao() to anon, authenticated;

-- Sinal realtime legível também por anon (para o telão receber o evento).
drop policy if exists tv_sinal_sel on public.tv_sinal;
create policy tv_sinal_sel on public.tv_sinal for select to anon, authenticated using (true);

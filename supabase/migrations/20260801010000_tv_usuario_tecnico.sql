-- =============================================================================
-- TV ReATIVA — usuário técnico do telão + fim do acesso anônimo
-- =============================================================================
-- Retira a exposição pública dos indicadores (resultado/honorários/metas/
-- projeção/rankings são internos). A leitura passa a exigir sessão autenticada
-- do TELÃO (painel.tv@reativa.local) ou da GESTÃO (Amanda/Fernanda). Operadores
-- comuns e anônimos NÃO leem o snapshot por chamada direta.
--
-- O usuário do telão é o "painel" (perfil 'painel' em public.usuarios): é o de
-- MENOR permissão — bloqueado de alunos/CPF/pagamentos/acordos/etc. por ~96
-- políticas RLS `NOT eh_painel()`. Ele só consegue ler o snapshot da TV.
-- Geração/cálculo do snapshot seguem restritos à gestão (inalterado).
-- (A criação/senha do usuário painel é feita à parte em auth.users/usuarios.)
-- =============================================================================

-- Quem pode LER o snapshot da TV: telão (painel) + gestão.
create or replace function public.tv_pode_ler_snapshot()
 returns boolean language sql stable security definer set search_path to 'public'
as $fn$
  select lower(coalesce(auth.email(),'')) in (
    'painel.tv@reativa.local',       -- usuário técnico do telão (perfil painel)
    'amanda.seibel@aelbra.com.br',   -- Amanda (gestora)
    'cobranca04@aelbra.com.br'       -- Fernanda (supervisora)
  );
$fn$;

-- Leitura do snapshot — restrita ao telão/gestão (ou service_role interno).
create or replace function public.tv_snapshot_ler()
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $fn$
declare v_row public.tv_snapshot%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.tv_pode_ler_snapshot() then
    raise exception 'Acesso negado: leitura da TV restrita ao telao e a gestao.' using errcode = '42501';
  end if;
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
  if coalesce(auth.role(),'') <> 'service_role' and not public.tv_pode_ler_snapshot() then
    raise exception 'Acesso negado: leitura da TV restrita ao telao e a gestao.' using errcode = '42501';
  end if;
  select versao, gerado_em into v_versao, v_gerado from public.tv_snapshot where id = true;
  return jsonb_build_object('versao', coalesce(v_versao,0), 'gerado_em', v_gerado);
end;
$fn$;

-- Remove o acesso ANÔNIMO; mantém só authenticated (o guard restringe dentro).
revoke execute on function public.tv_snapshot_ler()   from anon;
revoke execute on function public.tv_snapshot_versao() from anon;
grant  execute on function public.tv_snapshot_ler()   to authenticated;
grant  execute on function public.tv_snapshot_versao() to authenticated;
revoke execute on function public.tv_pode_ler_snapshot() from anon;  -- uso interno

-- Sinal realtime: legível só pelo telão/gestão (sem anon).
drop policy if exists tv_sinal_sel on public.tv_sinal;
create policy tv_sinal_sel on public.tv_sinal for select to authenticated
  using (public.tv_pode_ler_snapshot());

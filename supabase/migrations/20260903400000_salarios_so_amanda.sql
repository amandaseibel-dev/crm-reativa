-- ============================================================================
-- Valores de salário de outras pessoas: só a Amanda lê.
-- ----------------------------------------------------------------------------
-- Auditoria de 03/09/2026 (pedido da Amanda: "tudo que conste valores de
-- salários de outras pessoas só eu tenho acesso"). RLS, rotas e buckets
-- estavam certos. Os dois furos estavam em função SECURITY DEFINER:
--
-- 1) `dre_snapshot` devolvia o payload inteiro do DRE para quem pode ler o
--    DRE -- Amanda OU perfil diretoria. A tela esconde as abas "Funcionários"
--    e "Folha" de quem não é a Amanda, mas o JSON que chega ao navegador da
--    diretoria trazia `funcionarios[].salario_base` (15 pessoas) e
--    `folha_detalhe` (remuneração + premiação por pessoa e mês). Agora, quando
--    quem chama não é a Amanda, o salário base sai da lista de funcionários e
--    a folha detalhada não vai. O total mensal da folha (`meses[].folha_total`,
--    a linha que o DRE mostra) continua.
--
-- 2) `usuario_pode_acessar_fechamento_remuneracao()` (gate de TODAS as tabelas
--    e RPCs do Fechamento de Remuneração) e `app_pode_borderos_importacoes()`
--    respondiam "é backend?" olhando `current_user`. Dentro de uma função
--    SECURITY DEFINER `current_user` é sempre o dono (postgres), então qualquer
--    token SEM e-mail -- um login anônimo do Supabase Auth -- passava no gate e
--    a RLS liberava as linhas. Simulado em prod: gate=true e a linha de config
--    do Fechamento apareceu. Hoje não há usuário sem e-mail, mas a porta
--    existia. Agora "backend" é só: nenhum token (cron, SQL editor, pg_net) ou
--    token do service_role.
--
-- A Projeção Hora a Hora NÃO muda: a Fernanda continua vendo a projeção da
-- operação, inclusive a premiação estimada por operador (decisão da Amanda,
-- 03/09/2026).
--
-- Rollback: supabase/rollbacks/20260903400000_salarios_so_amanda.rollback.sql
-- Teste:    supabase/tests/salarios_so_amanda_test.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Gate do Fechamento de Remuneração
-- ---------------------------------------------------------------------------
create or replace function public.usuario_pode_acessar_fechamento_remuneracao()
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $function$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    -- Sem e-mail no token. É backend só quando NÃO há token nenhum (cron,
    -- SQL editor, pg_net) ou quando o token é o do service_role. Um token de
    -- usuário sem e-mail (login anônimo) cai aqui e NÃO passa.
    -- Antes: `current_user in ('postgres', ...)`, que dentro de SECURITY
    -- DEFINER é sempre 'postgres' e liberava qualquer token sem e-mail.
    return auth.jwt() is null
        or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  end if;
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$function$;

comment on function public.usuario_pode_acessar_fechamento_remuneracao() is
  'Gate do Fechamento de Remuneração: só amanda.seibel (ativa em usuarios). Sem e-mail no token, só passa sem token (backend) ou service_role -- nunca uma sessão de usuário.';

-- ---------------------------------------------------------------------------
-- 2) Gate de borderôs / importações (mesmo padrão, mesma correção)
-- ---------------------------------------------------------------------------
create or replace function public.app_pode_borderos_importacoes()
returns boolean
language plpgsql stable security definer
set search_path to 'public'
as $function$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    return auth.jwt() is null
        or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  end if;
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) DRE: a diretoria lê o demonstrativo, não a folha por pessoa
-- ---------------------------------------------------------------------------
create or replace function public.dre_snapshot(p_ano integer)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $function$
declare
  v_payload jsonb;
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not public.dre_pode_ler() then
    raise exception 'Acesso negado: o DRE e da gerencia e da diretoria.' using errcode = '42501';
  end if;
  select payload into v_payload from public.snapshot_gerencial where chave='dre' and ano=p_ano;
  -- "sem 'meses'" cobre o snapshot nulo (1a vez) e o envenenado que ficou de
  -- antes da migration 20260903300000. Nos dois casos: recalcula.
  if v_payload is null or not (v_payload ? 'meses') then
    v_payload := public._dre_dados_calcula(p_ano);
    if v_payload ? 'meses' then
      insert into public.snapshot_gerencial(chave, ano, payload, gerado_por) values ('dre', p_ano, v_payload, 'bootstrap')
        on conflict (chave, ano) do update set payload=excluded.payload, gerado_em=now();
    end if;
  end if;

  -- Quem não é a Amanda (hoje: perfil diretoria) recebe o demonstrativo sem
  -- valor por pessoa: sai o salário base de cada funcionário e sai a folha
  -- detalhada. `meses[].folha_total` fica -- é a linha "Folha" do DRE.
  -- Sem token (cron / SQL editor) o payload vai inteiro: não há navegador.
  if auth.jwt() is not null and v_email <> 'amanda.seibel@aelbra.com.br' then
    v_payload := (v_payload - 'folha_detalhe')
      || jsonb_build_object('funcionarios',
           coalesce((select jsonb_agg(f - 'salario_base')
                       from jsonb_array_elements(coalesce(v_payload -> 'funcionarios', '[]'::jsonb)) f),
                    '[]'::jsonb));
  end if;
  return v_payload;
end;
$function$;

comment on function public.dre_snapshot(integer) is
  'Snapshot do DRE do ano. Amanda recebe tudo; diretoria recebe sem salario_base por funcionário e sem folha_detalhe (só o total mensal da folha).';

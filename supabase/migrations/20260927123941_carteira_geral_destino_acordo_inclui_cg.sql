-- ---------------------------------------------------------------------------
-- Destino do remanejamento de ACORDO: operador ATIVO **ou** a Carteira Geral.
--
-- POR QUE
-- A Carteira Geral e `perfil='carteira', ativo=false` -- e assim de proposito,
-- desde 20260925180744: `ativo=false` existe para ela NAO aparecer em seletor
-- de PESSOA da operacao (todos filtram .eq("ativo", true)). Mas o destino de um
-- acordo nao e um seletor de pessoa: a Carteira Geral e justamente o destino de
-- gestao. Medido em 27/09/2026, ela ja responde por 189 acordos.
--
-- A RPC carteira_geral_acordos_previa JA aceitava a Carteira Geral (ela testa
-- internal.carteira_geral_email() antes da checagem de operador ativo). Quem
-- nao a oferecia era a TELA, que montava o destino a partir de
-- carteira_geral_acordos_responsaveis() filtrando `ativo` -- e a Carteira Geral
-- cai fora desse filtro.
--
-- SEGUNDO BURACO, na mesma linha: o destino saia de "quem TEM acordo". Um
-- operador ATIVO sem acordo nenhum nao poderia receber. Hoje os 7 operadores
-- ativos tem acordo e ninguem notaria, mas a regra estava errada.
--
-- O QUE MUDA
-- 1. internal.acordo_destino_valido(text): UM predicado, a regra inteira.
-- 2. carteira_geral_acordos_destinos(): lista o que o predicado aceita --
--    Carteira Geral primeiro, depois os operadores ativos. E o que a tela usa.
-- 3. carteira_geral_acordos_previa passa a validar PELO PREDICADO, em vez de
--    repetir a regra inline. Tela e RPC deixam de poder divergir: sao a mesma
--    funcao.
--
-- O QUE NAO MUDA
-- Nenhum outro inativo entra: quem nao e operador ativo e nao e a Carteira
-- Geral continua recusado. A Olga segue podendo ser ORIGEM do filtro e NAO
-- destino. Nada de dado e movido.
--
-- Rollback em supabase/rollbacks/.
-- ---------------------------------------------------------------------------

do $pre$
begin
  if not exists (select 1 from pg_proc
                  where oid = 'public.carteira_geral_acordos_previa(uuid[],text,jsonb)'::regprocedure) then
    raise exception 'carteira_geral_acordos_previa nao existe -- aplique 20260927115823 antes desta.';
  end if;
end
$pre$;

-- 1) A REGRA, em um lugar so.
create or replace function internal.acordo_destino_valido(p_email text)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
  select case
    when nullif(btrim(coalesce(p_email,'')),'') is null then false
    -- a Carteira Geral e destino de GESTAO: entra apesar de ativo=false
    when lower(btrim(p_email)) = internal.carteira_geral_email() then true
    -- todo o resto tem de ser operador ATIVO
    else exists (select 1 from public.usuarios u
                  where lower(u.email) = lower(btrim(p_email))
                    and u.ativo and u.perfil = 'operador')
  end;
$fn$;

comment on function internal.acordo_destino_valido(text) is
  'Destino valido para remanejamento de ACORDO: operador ativo OU a Carteira Geral. Usada pela previa e pela lista de destinos, para tela e RPC nao divergirem.';

-- 2) A LISTA que a tela oferece -- exatamente o que o predicado aceita.
create or replace function public.carteira_geral_acordos_destinos()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
declare v_res jsonb;
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para ver destinos de acordo.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'email', email, 'nome', nome, 'tipo', tipo) order by ord, nome), '[]'::jsonb)
    into v_res
    from (
      -- primeiro, porque nao e uma pessoa: e o destino de gestao
      select 0 as ord, 'CARTEIRA_GERAL' as tipo,
             internal.carteira_geral_email() as email,
             coalesce((select u.nome from public.usuarios u
                        where lower(u.email) = internal.carteira_geral_email()),
                      'Carteira Geral') as nome
      union all
      -- NAO sai de "quem tem acordo": operador ativo sem acordo nenhum tambem
      -- pode receber.
      select 1, 'OPERADOR', lower(u.email), u.nome
        from public.usuarios u
       where u.ativo and u.perfil = 'operador'
         and lower(u.email) <> internal.carteira_geral_email()
    ) z;

  return v_res;
end;
$fn$;

-- 3) A PREVIA passa a usar o predicado, em vez de repetir a regra.
select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_acordos_previa',
$ancora$  if v_destino = internal.carteira_geral_email() then
    v_destino_nome := 'CARTEIRA GERAL';
  else
    select u.nome into v_destino_nome from public.usuarios u
     where lower(u.email) = v_destino and u.ativo and u.perfil = 'operador';
    if v_destino_nome is null then
      raise exception 'Destino invalido ou operador inativo: %', p_destino_email;
    end if;
  end if;$ancora$,
$novo$  -- MESMA regra da lista de destinos, pela MESMA funcao: operador ATIVO ou a
  -- Carteira Geral. Repetir a regra aqui foi o que deixou a tela divergir.
  if not internal.acordo_destino_valido(v_destino) then
    raise exception
      'Destino invalido: %. So operador ATIVO ou a Carteira Geral podem receber acordo.',
      coalesce(nullif(btrim(coalesce(p_destino_email,'')),''), '(vazio)')
      using errcode = '22023';
  end if;

  select u.nome into v_destino_nome from public.usuarios u where lower(u.email) = v_destino;
  v_destino_nome := coalesce(v_destino_nome,
    case when v_destino = internal.carteira_geral_email() then 'Carteira Geral' else v_destino end);$novo$,
  1);

-- ACL: portao interno, nunca revoke de authenticated.
revoke all on function public.carteira_geral_acordos_destinos() from public, anon;
grant execute on function public.carteira_geral_acordos_destinos() to authenticated;
revoke all on function internal.acordo_destino_valido(text) from public, anon, authenticated;
grant execute on function internal.acordo_destino_valido(text) to service_role;

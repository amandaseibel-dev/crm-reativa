-- ============================================================================
-- ROLLBACK de 20261007103000 -- devolve a Olga ao telão.
-- ============================================================================
-- Mesma técnica da migration, na direção inversa: lê o corpo VIVO das funções
-- com pg_get_functiondef, desfaz só os trechos e aborta se a âncora não
-- aparecer exatamente uma vez.
--
-- ORDEM: primeiro as funções param de ler tv_equipe_oculta, só depois a tabela
-- cai. Invertido, uma atualização da TV disparada no meio encontraria as
-- funções vivas apontando para uma tabela que já não existe.
--
-- O QUE ISTO **NÃO** DESFAZ: as linhas que foram para `ativo = false` em
-- tv_aniversariantes e tv_config continuam desligadas. Religar é decisão da
-- gestão, não efeito colateral de um rollback — e a migration não guardou quais
-- linhas tocou. Para religar, à mão:
--
--   update public.tv_aniversariantes set ativo = true where upper(nome) like '%OLGA%';
--   update public.tv_config set ativo = true where chave = 'aniversario_destaque';
--
-- USAR ISTO SÓ FAZ SENTIDO se a pessoa voltar à equipe, ou se a remoção tiver
-- sido um engano. Nenhum dado financeiro é afetado nos dois sentidos: v_ops
-- nunca entrou em cálculo de dinheiro.
-- ============================================================================

begin;

-- 1) Playlist volta a não filtrar.
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_re   text := 'from public\.portal_playlist\s+where ativo = true\s+and lower\(coalesce\(adicionado_por_email,''''\)\) not in \(select email from public\.tv_equipe_oculta\)';
  v_para text := 'from public.portal_playlist where ativo = true';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_atualizar' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_atualizar() nao existe neste banco.';
  end if;
  if position('tv_equipe_oculta' in v_src) = 0 then
    raise notice 'playlist ja estava sem o filtro; nada a fazer.';
    return;
  end if;
  select count(*) into v_n from regexp_matches(v_src, v_re, 'g');
  if v_n <> 1 then
    raise exception 'ancora da playlist encontrada % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;
  execute regexp_replace(v_src, v_re, v_para);
end
$patch$;

-- 2) Elogios voltam a não filtrar.
do $patch$
declare
  v_src text; v_novo text; v_n int;
  v_de   text := $a$where status_novo = 'ELOGIO_ATENDIMENTO' and elogio_aprovado_tv = true and lower(coalesce(registrado_por_email,'')) not in (select email from public.tv_equipe_oculta)$a$;
  v_para text := $a$where status_novo = 'ELOGIO_ATENDIMENTO' and elogio_aprovado_tv = true$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  v_n := (length(v_src) - length(replace(v_src, v_de, ''))) / greatest(length(v_de), 1);
  if v_n = 0 then
    raise notice 'elogios ja estavam sem o filtro; nada a fazer.';
    return;
  end if;
  if v_n <> 1 then
    raise exception 'ancora de elogios encontrada % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;
  execute replace(v_src, v_de, v_para);
end
$patch$;

-- 3) cobranca03 volta para a allowlist, na posição original (primeira).
do $patch$
declare
  v_src text; v_n int;
  v_de   text := $a$v_ops text[] := array[$a$;
  v_para text := $a$v_ops text[] := array['cobranca03@aelbra.com.br',$a$;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular' limit 1;
  if position('''cobranca03@aelbra.com.br''' in v_src) > 0 then
    raise notice 'cobranca03 ja estava em v_ops; nada a fazer.';
    return;
  end if;
  v_n := (length(v_src) - length(replace(v_src, v_de, ''))) / length(v_de);
  if v_n <> 1 then
    raise exception 'declaracao de v_ops encontrada % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;
  execute replace(v_src, v_de, v_para);
end
$patch$;

-- 4) Só agora a tabela.
drop table if exists public.tv_equipe_oculta;

commit;

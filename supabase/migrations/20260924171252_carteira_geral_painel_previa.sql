-- ---------------------------------------------------------------------------
-- CARTEIRA GERAL — painel, listagem e previa (tudo SO LEITURA)
--
-- Nenhuma funcao deste arquivo escreve titularidade. A previa grava apenas a
-- propria previa (a fotografia do que seria movido). Quem move e a migration
-- seguinte (carteira_geral_mover).
--
-- FONTE DO VALOR. `casos` tem QUATRO colunas de saldo e tres delas estao
-- abandonadas: em 24/09/2026, de 18.424 casos, `mensalidades_em_aberto` tinha
-- valor em 250 e `acordo_em_aberto` em 574. Usar qualquer uma delas mostraria
-- uma carteira vazia. A unica fonte viva e `public.calibragem_saldo_aluno`
-- (titulos ABERTO/em_aberto sem acordo e sem vinculo ativo + parcelas vivas de
-- acordo nao cancelado) — a mesma que a Calibragem e o alterar_responsavel_aluno
-- ja usam. E ela que este painel le.
--
-- ANO. Nao existe "ano do aluno": existe ano do VENCIMENTO de cada divida.
-- Um aluno com mensalidade de 2025 e parcela de 2026 aparece nos dois anos. O
-- valor por ano e exato e soma o total; a CONTAGEM por ano e de alunos
-- distintos naquele ano e, por isso, NAO soma o total geral. A tela diz isso.
-- ---------------------------------------------------------------------------

-- Filtro comum, em uma funcao so, para painel/lista/previa nunca divergirem.
-- Recebe o jsonb de filtros e devolve um aluno por linha, ja com dono e saldo.
create or replace function public.carteira_geral_base(p_filtros jsonb default '{}'::jsonb)
returns table (
  aluno_id uuid,
  caso_id uuid,
  nome text,
  cpf text,
  matricula text,
  dono_email text,
  dono_nome text,
  dono_classe text,
  saldo_mensalidade numeric,
  saldo_acordo numeric,
  saldo_total numeric,
  status_acionamento text,
  data_ultimo_acionamento date,
  data_retorno date,
  encerrado boolean
)
language sql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
  with filtro as (
    select nullif(btrim(coalesce(p_filtros->>'responsavel','')),'')        as responsavel,
           nullif(p_filtros->>'ano','')::int                               as ano,
           nullif(btrim(upper(coalesce(p_filtros->>'tipo',''))),'')        as tipo,
           coalesce((p_filtros->>'incluir_encerrados')::boolean, false)    as incluir_encerrados,
           coalesce((p_filtros->>'apenas_com_saldo')::boolean, true)       as apenas_com_saldo,
           nullif(btrim(coalesce(p_filtros->>'busca','')),'')              as busca
  ),
  -- Dividas por ano, para o recorte por ano/tipo. Filtra ANTES de juntar com
  -- casos: sem isto a consulta enriquece 18 mil casos para depois descartar.
  div as (
    select t.aluno_id,
           extract(year from t.vencimento)::int as ano,
           'MENSALIDADE'::text as tipo
      from public.acordos_titulos t
     where upper(coalesce(t.situacao,'')) = 'ABERTO'
       and lower(coalesce(t.status,''))   = 'em_aberto'
       and t.acordo_id is null
       and not exists (select 1 from public.acordo_titulo_vinculo v
                        where v.titulo_id = t.id and coalesce(v.ativo, true))
    union all
    select a.aluno_id,
           extract(year from p.vencimento)::int as ano,
           'ACORDO'::text as tipo
      from public.parcelas p
      join public.acordos a on a.id = p.acordo_id
     where lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
       and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
  ),
  alvo as (
    select distinct d.aluno_id
      from div d, filtro f
     where (f.ano  is null or d.ano  = f.ano)
       and (f.tipo is null or d.tipo = f.tipo)
  )
  select c.aluno_id,
         c.id as caso_id,
         coalesce(c.nome, c.nome_aluno, al.nome) as nome,
         coalesce(c.cpf_limpo, c.cpf) as cpf,
         c.matricula,
         lower(nullif(btrim(coalesce(c.operador_email,'')),'')) as dono_email,
         coalesce(u.nome, c.operador_nome) as dono_nome,
         case
           when nullif(btrim(coalesce(c.operador_email,'')),'') is null then 'SEM_OPERADOR'
           when lower(c.operador_email) = internal.carteira_geral_email() then 'CARTEIRA_GERAL'
           when u.email is null then 'DESCONHECIDO'
           when not u.ativo then 'INATIVO'
           when u.perfil <> 'operador' then 'NAO_OPERADOR'
           else 'OPERADOR'
         end as dono_classe,
         round(coalesce(s.saldo_mensalidade,0),2) as saldo_mensalidade,
         round(coalesce(s.saldo_acordo,0),2)      as saldo_acordo,
         round(coalesce(s.saldo_total,0),2)       as saldo_total,
         c.status_acionamento,
         c.data_ultimo_acionamento,
         c.data_retorno,
         c.encerrado_operacional as encerrado
    from public.casos c
    join alvo on alvo.aluno_id = c.aluno_id
    join public.alunos al on al.id = c.aluno_id
    left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
    left join public.usuarios u on lower(u.email) = lower(c.operador_email)
   cross join filtro f
   where (f.incluir_encerrados or not c.encerrado_operacional)
     and (not f.apenas_com_saldo or coalesce(s.saldo_total,0) > 0)
     and (
       f.responsavel is null
       or (f.responsavel = 'SEM_OPERADOR'   and nullif(btrim(coalesce(c.operador_email,'')),'') is null)
       or (f.responsavel = 'CARTEIRA_GERAL' and lower(coalesce(c.operador_email,'')) = internal.carteira_geral_email())
       or (f.responsavel = 'SEM_DONO_ATIVO' and (
             nullif(btrim(coalesce(c.operador_email,'')),'') is null
             or u.email is null or not u.ativo or u.perfil <> 'operador'))
       or lower(coalesce(c.operador_email,'')) = lower(f.responsavel)
     )
     and (f.busca is null
          or coalesce(c.nome, c.nome_aluno, al.nome) ilike '%'||f.busca||'%'
          or coalesce(c.cpf_limpo, c.cpf, '') like '%'||regexp_replace(f.busca,'\D','','g')||'%'
          or coalesce(c.matricula,'') ilike '%'||f.busca||'%');
$fn$;

-- Sem grant para `authenticated`: esta funcao nao tem portao proprio e devolve
-- a carteira inteira. Quem a usa sao painel/lista/previa, que sao SECURITY
-- DEFINER e checam calibragem_e_gestao() antes — dentro delas o usuario efetivo
-- e o dono (postgres), entao o execute nao e necessario para o chamador.
revoke all on function public.carteira_geral_base(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PAINEL — contagem e valor por ano, por tipo de divida e por responsavel.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_painel(p_filtros jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
as $fn$
declare v_res jsonb; v_alunos uuid[];
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para ver a Carteira Geral.' using errcode = '42501';
  end if;

  create temp table _cg on commit drop as
    select * from public.carteira_geral_base(p_filtros);

  select array_agg(aluno_id) into v_alunos from _cg;
  v_alunos := coalesce(v_alunos, '{}'::uuid[]);

  select jsonb_build_object(
    'total_alunos', (select count(*) from _cg),
    'total_valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg),
    'total_mensalidade', (select round(coalesce(sum(saldo_mensalidade),0),2) from _cg),
    'total_acordo',      (select round(coalesce(sum(saldo_acordo),0),2) from _cg),
    'sem_operador', jsonb_build_object(
       'alunos', (select count(*) from _cg where dono_classe = 'SEM_OPERADOR'),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe = 'SEM_OPERADOR')),
    'na_carteira_geral', jsonb_build_object(
       'alunos', (select count(*) from _cg where dono_classe = 'CARTEIRA_GERAL'),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe = 'CARTEIRA_GERAL')),
    -- "responsavel que nao e operador ativo": inclui operador desligado
    -- (ativo=false), e-mail que nao existe mais em `usuarios`, e perfil que nao
    -- e operador (juridico, gerencia, ADM). Os tres significam a mesma coisa na
    -- pratica: ninguem da fila esta trabalhando este aluno.
    'responsavel_inativo', jsonb_build_object(
       'alunos', (select count(*) from _cg where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR')),
       'valor',  (select round(coalesce(sum(saldo_total),0),2) from _cg where dono_classe in ('INATIVO','DESCONHECIDO','NAO_OPERADOR'))),
    'por_responsavel', (
      select coalesce(jsonb_agg(x order by (x->>'alunos')::int desc), '[]'::jsonb) from (
        select jsonb_build_object(
                 'email', coalesce(dono_email,''),
                 'nome', case dono_classe
                           when 'SEM_OPERADOR' then 'Sem operador'
                           when 'CARTEIRA_GERAL' then 'Carteira Geral'
                           else coalesce(dono_nome, dono_email) end,
                 'classe', dono_classe,
                 'alunos', count(*),
                 'valor', round(coalesce(sum(saldo_total),0),2),
                 'mensalidade', round(coalesce(sum(saldo_mensalidade),0),2),
                 'acordo', round(coalesce(sum(saldo_acordo),0),2)
               ) as x
          from _cg group by dono_email, dono_nome, dono_classe
      ) t),
    -- Por ano do VENCIMENTO da divida. O valor soma o total; a contagem de
    -- alunos NAO, porque um aluno com divida em dois anos conta nos dois.
    'por_ano', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'ano', ano, 'tipo', tipo,
               'alunos', alunos, 'itens', itens, 'valor', valor) order by ano desc, tipo), '[]'::jsonb)
        from (
          select d.ano, d.tipo, count(distinct d.aluno_id) alunos, count(*) itens,
                 round(sum(d.valor),2) valor
            from (
              select t.aluno_id, extract(year from t.vencimento)::int ano, 'MENSALIDADE' tipo,
                     coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) valor
                from public.acordos_titulos t
               where t.aluno_id = any(v_alunos)
                 and upper(coalesce(t.situacao,'')) = 'ABERTO'
                 and lower(coalesce(t.status,''))   = 'em_aberto'
                 and t.acordo_id is null
                 and not exists (select 1 from public.acordo_titulo_vinculo v
                                  where v.titulo_id = t.id and coalesce(v.ativo, true))
              union all
              select a.aluno_id, extract(year from p.vencimento)::int ano, 'ACORDO' tipo,
                     coalesce(p.valor,0) valor
                from public.parcelas p
                join public.acordos a on a.id = p.acordo_id
               where a.aluno_id = any(v_alunos)
                 and lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
                 and upper(coalesce(p.status,'')) not in ('PAGO','PAGA','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
            ) d
           group by d.ano, d.tipo
        ) t)
  ) into v_res;

  return v_res;
end;
$fn$;

revoke all on function public.carteira_geral_painel(jsonb) from public, anon;
grant execute on function public.carteira_geral_painel(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- LISTA — o que a gestao seleciona na tela.
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_listar(
  p_filtros jsonb default '{}'::jsonb,
  p_limite integer default 200,
  p_offset integer default 0
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
declare v_res jsonb;
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para ver a Carteira Geral.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.saldo_total desc), '[]'::jsonb)
    into v_res
    from (
      select b.*,
             (select count(*) from public.acordos a
               where a.aluno_id = b.aluno_id
                 and lower(coalesce(a.status,'')) not in ('cancelado','cancelada')) as acordos_vivos,
             (select count(*) from public.acordos a
               where a.aluno_id = b.aluno_id
                 and lower(coalesce(a.status,'')) not in ('cancelado','cancelada')
                 and lower(coalesce(a.operador_responsavel_email,'')) is distinct from coalesce(b.dono_email,'')) as acordos_de_outro_dono
        from public.carteira_geral_base(p_filtros) b
       order by b.saldo_total desc
       limit greatest(coalesce(p_limite, 200), 1)
      offset greatest(coalesce(p_offset, 0), 0)
    ) t;

  return v_res;
end;
$fn$;

revoke all on function public.carteira_geral_listar(jsonb, integer, integer) from public, anon;
grant execute on function public.carteira_geral_listar(jsonb, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- PREVIA — a fotografia do que seria movido. NAO move nada.
--
-- Congela a lista de alunos e registra os conflitos. A execucao (migration
-- seguinte) so aceita esta previa; se algo mudou no meio do caminho, o item e
-- recusado e aparece no resultado. Nunca "reinterpreta".
-- ---------------------------------------------------------------------------
create or replace function public.carteira_geral_previa(
  p_aluno_ids uuid[],
  p_destino_tipo text,
  p_destino_email text default null,
  p_mover_acordos boolean default true,
  p_filtros jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
as $fn$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_destino_email text;
  v_destino_nome  text;
  v_previa_id uuid;
  v_itens jsonb;
  v_conflitos jsonb;
  v_res jsonb;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para remanejar carteira.' using errcode = '42501';
  end if;
  if p_destino_tipo not in ('CARTEIRA_GERAL','OPERADOR','FILA_LIVRE') then
    raise exception 'Destino invalido: %', p_destino_tipo;
  end if;
  if p_aluno_ids is null or array_length(p_aluno_ids,1) is null then
    raise exception 'Nenhum aluno selecionado.';
  end if;

  if p_destino_tipo = 'CARTEIRA_GERAL' then
    v_destino_email := internal.carteira_geral_email();
    v_destino_nome  := 'CARTEIRA GERAL';
  elsif p_destino_tipo = 'FILA_LIVRE' then
    v_destino_email := null;
    v_destino_nome  := null;
  else
    v_destino_email := lower(btrim(coalesce(p_destino_email,'')));
    select u.nome into v_destino_nome from public.usuarios u
      where lower(u.email) = v_destino_email and u.ativo and u.perfil = 'operador';
    if v_destino_nome is null then
      raise exception 'Operador de destino invalido ou inativo: %', p_destino_email;
    end if;
  end if;

  -- Fotografia por aluno. Le a titularidade nas TRES fontes, porque elas podem
  -- divergir: `casos.operador_email`, `alunos.responsavel_atual_email` e
  -- `acordos.operador_responsavel_email`.
  select coalesce(jsonb_agg(to_jsonb(t) order by t.saldo_total desc), '[]'::jsonb)
    into v_itens
    from (
      select c.aluno_id,
             c.id as caso_id,
             coalesce(c.nome, c.nome_aluno, al.nome) as nome,
             coalesce(c.cpf_limpo, c.cpf) as cpf,
             lower(nullif(btrim(coalesce(c.operador_email,'')),''))           as caso_de_email,
             lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),'')) as aluno_de_email,
             round(coalesce(s.saldo_mensalidade,0),2) as saldo_mensalidade,
             round(coalesce(s.saldo_acordo,0),2)      as saldo_acordo,
             round(coalesce(s.saldo_total,0),2)       as saldo_total,
             c.data_retorno,
             c.status_acionamento,
             c.encerrado_operacional as encerrado,
             (select coalesce(jsonb_agg(jsonb_build_object(
                        'acordo_id', a.id, 'numero', a.numero_acordo, 'status', a.status,
                        'de_email', lower(coalesce(a.operador_responsavel_email,'')),
                        'valor', round(coalesce(a.valor_total,0),2))), '[]'::jsonb)
                from public.acordos a
               where a.aluno_id = c.aluno_id
                 and lower(coalesce(a.status,'')) not in ('cancelado','cancelada')) as acordos
        from public.casos c
        join public.alunos al on al.id = c.aluno_id
        left join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id
       where c.aluno_id = any(p_aluno_ids)
    ) t;

  -- Conflitos: nao bloqueiam, mas aparecem na tela antes do OK.
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_conflitos from (
    select jsonb_build_object(
             'tipo', 'TITULARIDADE_DIVERGENTE',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'detalhe', 'O caso e de '||coalesce(nullif(it->>'caso_de_email',''),'ninguem')||
                        ' e a ficha do aluno e de '||coalesce(nullif(it->>'aluno_de_email',''),'ninguem')||'.') as x
      from jsonb_array_elements(v_itens) it
     where coalesce(it->>'caso_de_email','') is distinct from coalesce(it->>'aluno_de_email','')
    union all
    select jsonb_build_object(
             'tipo', case when p_mover_acordos then 'ACORDO_DE_OUTRO_DONO' else 'ACORDO_FICA_COM_O_DONO_ATUAL' end,
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'detalhe', 'Acordo '||coalesce(ac->>'numero','sem numero')||' esta com '||
                        coalesce(nullif(ac->>'de_email',''),'ninguem')||
                        case when p_mover_acordos then ' e vai junto.' else ' e NAO vai junto.' end)
      from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos') ac
     where coalesce(ac->>'de_email','') is distinct from coalesce(it->>'caso_de_email','')
    union all
    select jsonb_build_object(
             'tipo', 'RETORNO_AGENDADO_SERA_LIMPO',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'detalhe', 'Tem retorno agendado para '||(it->>'data_retorno')||
                        '. Trocar de dono limpa o agendamento (regra de internal.set_resp_aluno).')
      from jsonb_array_elements(v_itens) it
     where nullif(it->>'data_retorno','') is not null
    union all
    select jsonb_build_object(
             'tipo', 'CASO_ENCERRADO',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'detalhe', 'Caso encerrado operacionalmente — mover nao o reabre.')
      from jsonb_array_elements(v_itens) it
     where (it->>'encerrado')::boolean
  ) c;

  -- Teto do operador de destino. Nao e conflito por item: e do lote inteiro.
  -- O gatilho trigger_impor_teto_operador libera o excedente sozinho (manda de
  -- volta para a fila livre, do menor valor para cima). Melhor a gestao saber
  -- ANTES de confirmar do que descobrir depois que 200 casos sumiram.
  if p_destino_tipo = 'OPERADOR' then
    declare v_teto int; v_carga int; v_depois int;
    begin
      v_teto := public.calibragem_teto_operador(v_destino_email);
      select count(*) into v_carga from public.casos c
       where lower(c.operador_email) = v_destino_email
         and not c.encerrado_operacional;
      v_depois := v_carga + jsonb_array_length(v_itens);
      if v_depois > v_teto then
        v_conflitos := v_conflitos || jsonb_build_object(
          'tipo', 'TETO_DO_OPERADOR',
          'aluno_id', null,
          'nome', v_destino_nome,
          'detalhe', v_destino_nome||' tem '||v_carga||' casos e ficaria com '||v_depois||
                     ', acima do teto de '||v_teto||'. O gatilho de teto vai soltar '||
                     (v_depois - v_teto)||' caso(s) para a fila livre, do menor valor para cima.');
      end if;
    end;
  end if;

  insert into public.carteira_geral_previas
    (criado_por_email, filtros, destino_tipo, destino_email, itens,
     total_alunos, total_acordos, total_valor, conflitos)
  values
    (v_autor, coalesce(p_filtros,'{}'::jsonb), p_destino_tipo, v_destino_email, v_itens,
     jsonb_array_length(v_itens),
     (select count(*)::int from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos')),
     (select coalesce(sum((it->>'saldo_total')::numeric),0) from jsonb_array_elements(v_itens) it),
     v_conflitos)
  returning id into v_previa_id;

  select jsonb_build_object(
    'previa_id', v_previa_id,
    'destino_tipo', p_destino_tipo,
    'destino_email', v_destino_email,
    'destino_nome', coalesce(v_destino_nome, 'Fila livre'),
    'mover_acordos', p_mover_acordos,
    'total_alunos', jsonb_array_length(v_itens),
    'total_acordos', (select count(*)::int from jsonb_array_elements(v_itens) it, jsonb_array_elements(it->'acordos')),
    'total_valor', (select coalesce(sum((it->>'saldo_total')::numeric),0) from jsonb_array_elements(v_itens) it),
    'total_mensalidade', (select coalesce(sum((it->>'saldo_mensalidade')::numeric),0) from jsonb_array_elements(v_itens) it),
    'total_acordo_valor', (select coalesce(sum((it->>'saldo_acordo')::numeric),0) from jsonb_array_elements(v_itens) it),
    'itens', v_itens,
    'conflitos', v_conflitos
  ) into v_res;

  return v_res;
end;
$fn$;

revoke all on function public.carteira_geral_previa(uuid[], text, text, boolean, jsonb) from public, anon;
grant execute on function public.carteira_geral_previa(uuid[], text, text, boolean, jsonb) to authenticated;

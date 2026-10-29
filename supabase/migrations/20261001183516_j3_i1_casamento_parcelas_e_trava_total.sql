-- ============================================================================
-- J3/I1 — correcao de dois pontos achados na PRIMEIRA captura real (18:14Z de
-- 2026-10-01, escopo c5f24038, 22 presencas).
--
-- 1) CASAMENTO DE PARCELA DE ACORDO
--    A trilha gravou os 22 documentos com 12 digitos ('0' + boleto) e nenhum
--    casou: o teste "este documento e conhecido?" so olhava
--    acordos_titulos.documento, e parcela de acordo mora em parcelas.boleto,
--    que guarda 11 digitos. Resultado: 22 de 22 classificados como
--    DESCONHECIDOS e 22 CPFs gravados sem necessidade.
--
--    MEDIDO em 2026-10-01 antes de escolher a normalizacao:
--      . ltrim(x,'0') NAO colide dentro de parcelas       (13.826 = 13.826)
--      . ltrim(x,'0') NAO colide dentro de acordos_titulos (47.949 = 47.949)
--      . 377 chaves existem nas DUAS tabelas; 376 apontam para o MESMO aluno
--        e 1 divergir. Por isso a precedencia e FIXA: titulo primeiro,
--        parcela somente como fallback. Assim o caso ambiguo resolve como ja
--        resolvia e o caminho novo age SO onde nao existe titulo.
--
--    Feito em forma de CONJUNTO (hash join unico), nao por subconsulta
--    correlacionada: um TOTAL real tem ~48.000 linhas e uma consulta por linha
--    sobre 47.949 titulos seria 48.000 varreduras. Tambem por isso NAO se cria
--    indice em acordos_titulos nem em parcelas -- essas tabelas nao sao tocadas.
--
-- 2) TRAVA DO TOTAL
--    O snapshot de 18:14Z declarou TOTAL com 22 titulos / R$ 19.265,01 contra
--    um universo de 41.240 documentos em aberto -- 0,053%. A regra BOOTSTRAP
--    segurou em TOTAL_PENDENTE_VALIDACAO, mas nada impedia a validacao manual
--    de promove-lo a baseline. Agora impede.
--
-- NAO ALTERA: parcelas, acordos, acordos_titulos, saldo, filas, vinculos.
-- Zero DML. Nenhum snapshot existente muda de estado.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. FORMA CANONICA DO DOCUMENTO
--    Uma funcao so, para os tres consumidores nao divergirem em silencio.
--    nullif(...,'') garante que documento todo-zero nunca casa com nada.
-- ---------------------------------------------------------------------------
create or replace function public.extracao_documento_norm(p_documento text)
returns text language sql immutable parallel safe as $$
  select nullif(ltrim(coalesce(p_documento,''), '0'), '')
$$;

comment on function public.extracao_documento_norm(text) is
  'J3: forma canonica do numero de documento/boleto para casar a trilha com '
  'acordos_titulos.documento (12 digitos) e parcelas.boleto (11 digitos). '
  'MEDIDO em 2026-10-01: ltrim por zero a esquerda nao colide em nenhuma das '
  'duas tabelas. IMMUTABLE de proposito: permite indice por expressao se um dia '
  'for preciso.';

revoke all on function public.extracao_documento_norm(text) from public, anon;
grant execute on function public.extracao_documento_norm(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. RPC DE CAPTURA — reconhece parcela de acordo e nao duplica CPF
--    Muda SO: (a) a decisao do CPF, agora por conjunto; (b) a metrica
--    alunos_distintos, com a mesma precedencia. O resto e identico.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_presenca_extracao(
  p_importacao_id  uuid,
  p_source_type    text,
  p_scope_key      text,
  p_completude     text,        -- 'TOTAL' | 'PARCIAL'
  p_snapshot_at    timestamptz,
  p_arquivo_nome   text,
  p_arquivo_hash   text,
  p_linhas_arquivo integer,     -- TOTAL de linhas do arquivo
  p_linhas         jsonb        -- [{documento, cpf, tipo_boleto, situacao, valor, venc}]
) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_escopo_id uuid;
  v_grav int := 0;
  v_aval jsonb;
  v_estado text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Apenas a gestão pode registrar presença de extração.'
      using errcode = '42501';
  end if;
  if p_completude not in ('TOTAL','PARCIAL') then
    raise exception 'Completude inválida: %', p_completude using errcode = '22023';
  end if;
  if p_arquivo_hash is null or length(p_arquivo_hash) < 32 then
    raise exception 'arquivo_hash obrigatório (SHA-256).' using errcode = '22023';
  end if;

  -- IDEMPOTÊNCIA: mesmo arquivo reenviado devolve o escopo existente e NAO
  -- regrava nada -- nao cria sequencia nova nem falsa ausencia.
  select id into v_escopo_id from public.extracao_escopo
   where arquivo_hash = p_arquivo_hash;
  if v_escopo_id is not null then
    return jsonb_build_object('escopo_id', v_escopo_id, 'linhas_gravadas', 0,
                              'reaproveitado', true,
                              'estado', (select estado from public.extracao_escopo
                                          where id = v_escopo_id));
  end if;

  insert into public.extracao_escopo
    (importacao_id, source_type, scope_key, completude, estado, snapshot_at,
     arquivo_nome, arquivo_hash, linhas_arquivo, linhas_capturadas, declarado_por)
  values
    (p_importacao_id, p_source_type, p_scope_key, p_completude,
     case when p_completude = 'PARCIAL' then 'PARCIAL'
          else 'TOTAL_PENDENTE_VALIDACAO' end,          -- nunca nasce VALIDADO
     coalesce(p_snapshot_at, now()), p_arquivo_nome, p_arquivo_hash,
     coalesce(p_linhas_arquivo, 0),
     jsonb_array_length(coalesce(p_linhas,'[]'::jsonb)),
     coalesce(auth.jwt() ->> 'email','desconhecido'))
  returning id into v_escopo_id;

  with linha as (
    select
      nullif(btrim(x->>'documento'),'')                             as documento,
      nullif(regexp_replace(coalesce(x->>'cpf',''),'\D','','g'),'')  as cpf,
      nullif(btrim(x->>'tipo_boleto'),'')                            as tipo_boleto,
      nullif(btrim(x->>'situacao'),'')                               as situacao,
      nullif(x->>'valor','')::numeric                                as valor,
      nullif(x->>'venc','')::date                                    as venc
      from jsonb_array_elements(coalesce(p_linhas,'[]'::jsonb)) x
  ),
  dedup as (   -- mesmo documento 2x no arquivo: fica 1 linha (a de maior valor)
    select distinct on (documento) * from linha
     where documento is not null order by documento, valor desc nulls last
  ),
  -- CONHECIDOS DO CRM, em CONJUNTO. Inclui parcela de acordo: o numero que o
  -- relatorio traz como '0'+boleto mora em parcelas.boleto sem o zero.
  -- Um hash build sobre as duas tabelas, nao uma consulta por linha.
  conhecidos as (
    select public.extracao_documento_norm(t.documento) as k
      from public.acordos_titulos t
     where t.documento is not null
    union
    select public.extracao_documento_norm(pa.boleto)
      from public.parcelas pa
     where pa.boleto is not null
  )
  insert into public.titulo_presenca_importacao
    (escopo_id, documento, cpf_digitos, tipo_boleto_id, situacao_id,
     valor_observado, vencimento, chave_sintetica)
  select v_escopo_id, d.documento,
         -- CPF so quando o documento e DESCONHECIDO do CRM (evita duplicar PII)
         case when c.k is not null then null else d.cpf end,
         public.extracao_rotulo_id('TIPO_BOLETO', d.tipo_boleto),
         public.extracao_rotulo_id('SITUACAO',    d.situacao),
         d.valor, d.venc,
         (d.documento !~ '^[0-9]{6,13}$')          -- MANUAL-* e afins
    from dedup d
    left join conhecidos c on c.k = public.extracao_documento_norm(d.documento)
  on conflict (escopo_id, documento) do nothing;

  get diagnostics v_grav = row_count;

  -- metricas do snapshot, para a validacao e a observabilidade
  update public.extracao_escopo e
     set linhas_capturadas = v_grav,
         titulos_distintos = (select count(*) from public.titulo_presenca_importacao p
                               where p.escopo_id = v_escopo_id and not p.chave_sintetica),
         -- PRECEDENCIA FIXA titulo > parcela > cpf (ver cabecalho: 1 dos 377
         -- pares divergentes, e o titulo manda).
         alunos_distintos  = (
           select count(distinct coalesce(t.aluno_id::text, pa.aluno_id::text, p.cpf_digitos))
             from public.titulo_presenca_importacao p
             left join public.acordos_titulos t
                    on public.extracao_documento_norm(t.documento)
                     = public.extracao_documento_norm(p.documento)
             left join (select distinct public.extracao_documento_norm(pa2.boleto) as k,
                               a2.aluno_id
                          from public.parcelas pa2
                          join public.acordos a2 on a2.id = pa2.acordo_id
                         where pa2.boleto is not null) pa
                    on pa.k = public.extracao_documento_norm(p.documento)
            where p.escopo_id = v_escopo_id),
         valor_total       = (select round(coalesce(sum(p.valor_observado),0),2)
                                from public.titulo_presenca_importacao p
                               where p.escopo_id = v_escopo_id)
   where e.id = v_escopo_id;

  -- avalia e promove a TOTAL_VALIDADO so dentro das faixas
  v_aval := public.extracao_avaliar_total(v_escopo_id);
  v_estado := v_aval->>'estado';
  if v_estado = 'TOTAL_VALIDADO' then
    update public.extracao_escopo
       set estado = 'TOTAL_VALIDADO', validacao_motivo = v_aval,
           validado_por = 'automatico', validado_em = now()
     where id = v_escopo_id;
  else
    update public.extracao_escopo set validacao_motivo = v_aval
     where id = v_escopo_id;
  end if;

  return jsonb_build_object('escopo_id', v_escopo_id, 'linhas_gravadas', v_grav,
                            'reaproveitado', false,
                            'estado', (select estado from public.extracao_escopo
                                        where id = v_escopo_id),
                            'avaliacao', v_aval);
end;
$$;

revoke all on function public.registrar_presenca_extracao(
  uuid,text,text,text,timestamptz,text,text,integer,jsonb) from public, anon;
grant execute on function public.registrar_presenca_extracao(
  uuid,text,text,text,timestamptz,text,text,integer,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. TRAVA DO TOTAL NA VALIDACAO MANUAL
--    Um TOTAL que diz TIPO=TODOS nao pode virar baseline com um punhado de
--    linhas. Limiar unico e deliberadamente frouxo (50%): existe para barrar o
--    absurdo (0,053%), nao para julgar oscilacao normal. REPROVAR nunca e
--    barrado -- recusar um snapshot ruim precisa continuar sempre possivel.
-- ---------------------------------------------------------------------------
create or replace function public.extracao_validar(
  p_escopo_id uuid, p_decisao text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_estado    text;
  v_e         public.extracao_escopo;
  v_universo  bigint;
  v_min       numeric := 0.50;   -- piso provisorio, calibravel por migration
begin
  if not public.app_pode_borderos_importacoes() then
    raise exception 'Somente a gerencia pode validar um snapshot TOTAL: a validacao cria baseline.'
      using errcode = '42501';
  end if;
  if p_decisao not in ('VALIDAR','REPROVAR') then
    raise exception 'Decisão inválida: %', p_decisao using errcode = '22023';
  end if;

  -- ===== TRAVA DE VOLUME (so para VALIDAR, so para TIPO=TODOS) =============
  if p_decisao = 'VALIDAR' then
    select * into v_e from public.extracao_escopo where id = p_escopo_id;
    if v_e.id is not null
       and v_e.completude = 'TOTAL'
       and v_e.scope_key like '%TIPO=TODOS%' then
      select count(distinct t.documento) into v_universo
        from public.acordos_titulos t
       where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO');
      if coalesce(v_e.titulos_distintos,0) < v_min * coalesce(v_universo,0) then
        raise exception
          'Volume incompativel com o escopo declarado TIPO=TODOS: o snapshot tem % titulos e o universo em aberto tem % (% por cento do universo; minimo % por cento). Marque PARCIAL ou REPROVAR.',
          coalesce(v_e.titulos_distintos,0), coalesce(v_universo,0),
          round(100.0*coalesce(v_e.titulos_distintos,0)/nullif(v_universo,0), 3),
          round(100*v_min,0)
          using errcode = '22023';
      end if;
    end if;
  end if;
  -- =========================================================================

  v_estado := case p_decisao when 'VALIDAR' then 'TOTAL_VALIDADO'
                             else 'TOTAL_REPROVADO' end;
  update public.extracao_escopo
     set estado = v_estado,
         validado_por = coalesce(auth.jwt() ->> 'email','desconhecido'),
         validado_em  = now(),
         validacao_motivo = coalesce(validacao_motivo,'{}'::jsonb)
           || jsonb_build_object('decisao_humana', p_decisao, 'motivo_humano', p_motivo)
   where id = p_escopo_id and completude = 'TOTAL'
     and estado = 'TOTAL_PENDENTE_VALIDACAO';
  if not found then
    raise exception 'Escopo % não está em TOTAL_PENDENTE_VALIDACAO.', p_escopo_id
      using errcode = '22023';
  end if;
  return jsonb_build_object('escopo_id', p_escopo_id, 'estado', v_estado);
end;
$$;

revoke all on function public.extracao_validar(uuid,text,text) from public, anon;
grant execute on function public.extracao_validar(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. VIEW DE HISTORICO — aluno_id resolve parcela de acordo tambem
--    Mesma lista de colunas, mesma ordem (create or replace exige). A unica
--    mudanca e aluno_id: era subconsulta so em acordos_titulos, agora e JOIN
--    com precedencia titulo > parcela. Em forma de conjunto, nao por linha.
-- ---------------------------------------------------------------------------
create or replace view public.vw_titulo_presenca_historico as
with comparavel as (
  select e.id, e.source_type, e.scope_key, e.snapshot_at,
         row_number() over (partition by e.source_type, e.scope_key
                            order by e.snapshot_at) as seq
    from public.extracao_escopo e
   where e.estado = 'TOTAL_VALIDADO'        -- <<< a trava central
),
presenca as (
  select p.documento, c.source_type, c.scope_key, c.seq, c.snapshot_at
    from public.titulo_presenca_importacao p
    join comparavel c on c.id = p.escopo_id
   where not p.chave_sintetica              -- exclui MANUAL-* da inferencia
),
janela as (
  select documento, source_type, scope_key,
         min(seq) as primeira_seq, max(seq) as ultima_seq,
         min(snapshot_at) as first_seen_at, max(snapshot_at) as last_seen_at,
         count(*) as extracoes_presente
    from presenca group by 1,2,3
),
grade as (
  select j.documento, j.source_type, j.scope_key, c.seq, c.snapshot_at,
         exists (select 1 from presenca p
                  where p.documento = j.documento and p.scope_key = j.scope_key
                    and p.source_type = j.source_type and p.seq = c.seq) as presente,
         (c.seq <= j.ultima_seq) as dentro_da_janela
    from janela j
    join comparavel c on c.source_type = j.source_type
                     and c.scope_key   = j.scope_key
                     and c.seq        >= j.primeira_seq
),
-- identidade do documento: titulo manda; parcela de acordo entra no lugar dele
-- quando nao existe titulo (medido: 376 de 377 pares concordam, 1 divergir).
ident_titulo as (
  select distinct public.extracao_documento_norm(t.documento) as k, t.aluno_id
    from public.acordos_titulos t where t.documento is not null
),
ident_parcela as (
  select distinct public.extracao_documento_norm(pa.boleto) as k, a.aluno_id
    from public.parcelas pa join public.acordos a on a.id = pa.acordo_id
   where pa.boleto is not null
)
select j.documento,
       coalesce(it.aluno_id, ip.aluno_id)               as aluno_id,
       j.source_type, j.scope_key,
       j.first_seen_at, j.last_seen_at, j.extracoes_presente,
       (select count(*) from grade g where g.documento = j.documento
         and g.scope_key = j.scope_key and g.source_type = j.source_type
         and not g.presente and g.dentro_da_janela)      as ausencias_intermediarias,
       (select count(*) from grade g where g.documento = j.documento
         and g.scope_key = j.scope_key and g.source_type = j.source_type
         and not g.presente and not g.dentro_da_janela)  as ausencias_consecutivas,
       (select min(g.snapshot_at) from grade g where g.documento = j.documento
         and g.scope_key = j.scope_key and g.source_type = j.source_type
         and not g.presente)                             as primeira_ausencia_observada,
       -- REAPARECIMENTO: desqualifica como prova deterministica nesta sequencia
       ((select count(*) from grade g where g.documento = j.documento
          and g.scope_key = j.scope_key and g.source_type = j.source_type
          and not g.presente and g.dentro_da_janela) > 0) as reapareceu_desqualifica,
       (j.ultima_seq = (select max(c2.seq) from comparavel c2
                         where c2.source_type = j.source_type
                           and c2.scope_key = j.scope_key)) as presente_na_ultima_extracao,
       (select count(*) from comparavel c3
         where c3.source_type = j.source_type
           and c3.scope_key = j.scope_key)               as extracoes_comparaveis_do_escopo
  from janela j
  left join ident_titulo  it on it.k = public.extracao_documento_norm(j.documento)
  left join ident_parcela ip on ip.k = public.extracao_documento_norm(j.documento);

comment on view public.vw_titulo_presenca_historico is
  'J3: historico de presenca/ausencia por titulo. DIAGNOSTICO APENAS -- nenhuma '
  'inferencia de vinculo esta implementada e ausencia NAO e prova de incorporacao '
  'a acordo. So compara TOTAL_VALIDADO x TOTAL_VALIDADO do mesmo escopo. '
  'reapareceu_desqualifica=true elimina o titulo como prova determinista. '
  'aluno_id resolve por titulo e, quando nao houver titulo, por parcela de acordo '
  '(parcelas.boleto), com forma canonica de extracao_documento_norm.';

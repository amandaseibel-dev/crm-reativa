-- ============================================================================
-- J3 · I2 — LIGAR OS IMPORTADORES À TRILHA, EM LOTES, SEM LÓGICA DUPLICADA
--
-- NÃO APLICADO. Aguarda autorização.
--
-- O QUE ESTE ARQUIVO FAZ:
--   1. extrai a lógica compartilhada em DUAS funções internas:
--      `extracao_linhas_gravar`  e  `extracao_metricas_recalcular`;
--   2. reescreve `registrar_presenca_extracao` para CHAMAR essas duas em vez de
--      ter o código inline -- sem mudar comportamento;
--   3. adiciona `extracao_lote_anexar` e `extracao_lote_fechar`, que chamam AS
--      MESMAS duas funções, para a captura acontecer em lotes;
--   4. põe no fechamento um portão de conteúdo (declaração × conteúdo, e
--      composição × baseline).
--
-- POR QUE A EXTRAÇÃO (pedido de 01/10): a versão anterior deste arquivo mantinha
-- em `extracao_lote_anexar` uma CÓPIA do corpo de `registrar_presenca_extracao`.
-- Isso já deu errado uma vez nesta mesma frente: a migration
-- `20261001183516` trocou o teste "este documento é conhecido?" na função
-- original e a cópia ficou com a regra velha. O mesmo arquivo sairia com
-- `cpf_digitos` preenchido ou nulo dependendo de qual lote a linha caiu. Agora
-- não há cópia: há uma implementação e dois chamadores.
--
-- O QUE ESTE ARQUIVO NÃO FAZ:
--   · não altera nada de saldo, baixa, acordo, vínculo, fila ou efetividade;
--   · não mexe nos limiares `provisorio-2026-10-01`;
--   · não faz backfill de extração histórica nenhuma;
--   · não muda ACL de usuário nem caminho de service_role.
--
-- BASE DE PARTIDA: `registrar_presenca_extracao` como está em produção em
-- 01/10 (md5 de `pg_get_functiondef` = 3588d182aa4020f291edce50ad758953, 6.487
-- chars), depois de `20261001183516_j3_i1_casamento_parcelas_e_trava_total`.
-- Todo o resto do corpo dela é preservado literalmente.
--
-- POR QUE PRECISA DE LOTES (medido em produção em 01/10/2026):
--   · uma extração TOTAL real da carteira = 47.949 linhas / 7 MB de payload;
--   · com tudo de uma vez: 6.340 ms, contra `statement_timeout = 8s` do
--     `authenticated` -- 1.660 ms de margem;
--   · em lotes de 1.200: 132 ms por chamada.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. LÓGICA COMPARTILHADA — GRAVAR LINHAS
--
-- Única implementação do "como uma linha do arquivo vira uma linha de
-- presença": normalização dos campos, dedup por documento, decisão de guardar
-- ou não o CPF, rótulos e marcação de chave sintética.
--
-- INTERNA. Não recebe EXECUTE de `authenticated`: quem pode gravar presença é
-- decidido pelos chamadores (`usuario_e_gestao()`), e esta função sozinha não
-- tem portão. Chamada de dentro de função SECURITY DEFINER, roda com os
-- direitos do dono -- revogar de `authenticated` não quebra nenhum chamador.
-- ---------------------------------------------------------------------------
create or replace function public.extracao_linhas_gravar(
  p_escopo_id uuid,
  p_linhas    jsonb
) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare v_grav int := 0;
begin
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
  select p_escopo_id, d.documento,
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
  return v_grav;
end;
$$;

comment on function public.extracao_linhas_gravar(uuid,jsonb) is
  'J3/I2 INTERNA: unica implementacao de "linha do arquivo -> linha de '
  'presenca". Chamada por registrar_presenca_extracao e por '
  'extracao_lote_anexar. Nao tem portao de acesso: quem chama decide. '
  'Sem EXECUTE para authenticated/anon/public.';


-- ---------------------------------------------------------------------------
-- 2. LÓGICA COMPARTILHADA — RECALCULAR AS 4 MÉTRICAS
--
-- `linhas_capturadas` passa a ser `count(*)` sobre o escopo, em vez do
-- `row_count` da última inserção. Para um escopo recém-criado os dois são
-- iguais (nada havia antes, e o `on conflict` só derruba duplicata do próprio
-- lote, que o `dedup` já tinha derrubado); para uma captura em lotes só
-- `count(*)` está certo. Há teste de paridade para esta igualdade.
--
-- INTERNA, pelos mesmos motivos da 1.
-- ---------------------------------------------------------------------------
create or replace function public.extracao_metricas_recalcular(
  p_escopo_id uuid
) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare v_cap int;
begin
  select count(*) into v_cap from public.titulo_presenca_importacao
   where escopo_id = p_escopo_id;

  update public.extracao_escopo e
     set linhas_capturadas = v_cap,
         titulos_distintos = (select count(*) from public.titulo_presenca_importacao p
                               where p.escopo_id = p_escopo_id and not p.chave_sintetica),
         -- PRECEDENCIA FIXA titulo > parcela > cpf (ver 20261001183516: dos 377
         -- pares que existem nas duas tabelas, 1 divergia, e o titulo manda).
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
            where p.escopo_id = p_escopo_id),
         valor_total       = (select round(coalesce(sum(p.valor_observado),0),2)
                                from public.titulo_presenca_importacao p
                               where p.escopo_id = p_escopo_id)
   where e.id = p_escopo_id;

  return v_cap;
end;
$$;

comment on function public.extracao_metricas_recalcular(uuid) is
  'J3/I2 INTERNA: unica implementacao das 4 metricas do snapshot. Chamada por '
  'registrar_presenca_extracao e por extracao_lote_fechar. '
  'Sem EXECUTE para authenticated/anon/public.';


-- ---------------------------------------------------------------------------
-- 3. `registrar_presenca_extracao` PASSA A CHAMAR AS DUAS
--
-- Corpo idêntico ao de produção em 01/10 (md5 3588d182), com dois trechos
-- substituídos por chamada:
--   · o bloco `with linha ... on conflict do nothing` + `get diagnostics`
--     -> `v_grav := public.extracao_linhas_gravar(...)`
--   · o `update ... set linhas_capturadas/titulos_distintos/alunos_distintos/
--     valor_total` -> `perform public.extracao_metricas_recalcular(...)`
-- Guardas, idempotência por hash, insert do escopo, avaliação, promoção e
-- retorno: tudo preservado literalmente.
-- ---------------------------------------------------------------------------
create or replace function public.registrar_presenca_extracao(
  p_importacao_id  uuid,
  p_source_type    text,
  p_scope_key      text,
  p_completude     text,
  p_snapshot_at    timestamptz,
  p_arquivo_nome   text,
  p_arquivo_hash   text,
  p_linhas_arquivo integer,
  p_linhas         jsonb
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

  v_grav := public.extracao_linhas_gravar(v_escopo_id, p_linhas);

  -- metricas do snapshot, para a validacao e a observabilidade
  perform public.extracao_metricas_recalcular(v_escopo_id);

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


-- ---------------------------------------------------------------------------
-- 4. ANEXAR UM LOTE a um escopo ainda aberto
--
-- Zero lógica de gravação própria: chama `extracao_linhas_gravar`.
--
-- NUNCA anexar a um snapshot ENCERRADO POR DECISÃO. Mas promoção AUTOMÁTICA no
-- meio de uma captura em lotes não é decisão: `registrar_presenca_extracao`
-- avalia e promove sobre o 1º lote, e se ele por acaso passar na faixa de
-- volume contra o baseline, o lote 2 seria recusado com 42501 e o arquivo
-- ficaria pela metade, com a metade marcada como referência válida. Reproduzido
-- em 01/10 (baseline 1.300; arquivo 1.800: 138% de linhas e 92% de títulos,
-- ambos na faixa). Então promoção automática é DESFEITA e a captura continua.
-- A avaliação que vale é a do fechamento, sobre o arquivo inteiro.
-- ---------------------------------------------------------------------------
create or replace function public.extracao_lote_anexar(
  p_escopo_id uuid,
  p_linhas    jsonb
) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_e    public.extracao_escopo;
  v_grav int := 0;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Apenas a gestão pode registrar presença de extração.'
      using errcode = '42501';
  end if;

  select * into v_e from public.extracao_escopo where id = p_escopo_id;
  if v_e.id is null then
    raise exception 'Escopo % inexistente.', p_escopo_id using errcode = '22023';
  end if;

  if v_e.estado = 'TOTAL_VALIDADO' and v_e.validado_por = 'automatico' then
    update public.extracao_escopo
       set estado = 'TOTAL_PENDENTE_VALIDACAO', validado_por = null, validado_em = null
     where id = p_escopo_id;
  elsif v_e.estado not in ('TOTAL_PENDENTE_VALIDACAO','PARCIAL') then
    raise exception 'Escopo % está em % (validado por %) -- lote só entra em snapshot aberto.',
      p_escopo_id, v_e.estado, coalesce(v_e.validado_por,'-') using errcode = '42501';
  end if;

  v_grav := public.extracao_linhas_gravar(p_escopo_id, p_linhas);
  return jsonb_build_object('escopo_id', p_escopo_id, 'linhas_gravadas', v_grav);
end;
$$;

comment on function public.extracao_lote_anexar(uuid,jsonb) is
  'I2: anexa um lote a um escopo ainda aberto, pela MESMA '
  'extracao_linhas_gravar que registrar_presenca_extracao usa. Desfaz promocao '
  'AUTOMATICA feita sobre o 1o lote. Recusa snapshot encerrado por decisao '
  'humana ou reprovado. Nao avalia e nao promove.';


-- ---------------------------------------------------------------------------
-- 5. FECHAR o escopo: recalcula as métricas (pela função compartilhada),
--    aplica o portão de conteúdo e avalia.
--
-- IDEMPOTENTE, com uma trava: se a gestão já validou ou reprovou à mão
-- (`validado_por` que não é 'automatico'), recusa. Fechamento atrasado nunca
-- sobrescreve decisão humana.
-- ---------------------------------------------------------------------------
create or replace function public.extracao_lote_fechar(
  p_escopo_id uuid
) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_e              public.extracao_escopo;
  v_aval           jsonb;
  v_estado         text;
  v_cap            int;
  v_tipos          smallint[];   -- extracao_rotulo.id e smallint
  v_tipos_base     smallint[];
  v_base_id        uuid;
  v_tipo_declarado text;
  v_bloqueio       text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Apenas a gestão pode registrar presença de extração.'
      using errcode = '42501';
  end if;

  select * into v_e from public.extracao_escopo where id = p_escopo_id;
  if v_e.id is null then
    raise exception 'Escopo % inexistente.', p_escopo_id using errcode = '22023';
  end if;

  if v_e.validado_por is not null and v_e.validado_por <> 'automatico' then
    raise exception 'Escopo % já tem decisão de % -- fechamento não sobrescreve.',
      p_escopo_id, v_e.validado_por using errcode = '42501';
  end if;

  v_cap := public.extracao_metricas_recalcular(p_escopo_id);

  -- =====================================================================
  -- PORTÃO DE CONTEÚDO ("não confie apenas na escolha manual TOTAL/PARCIAL").
  --
  -- A `scope_key` é declarada, e declaração não é prova. Aqui o CONTEÚDO é
  -- confrontado com ela. Só é possível no fechamento, porque só aqui todas as
  -- linhas já entraram -- no 1º lote o conjunto de tipos é parcial.
  --
  -- O portão NUNCA corrige: `scope_key` e `completude` são congelados por
  -- `tg_escopo_so_valida`, e reescrevê-los seria inventar uma declaração que
  -- ninguém fez. Ele recusa a promoção e registra o motivo.
  --
  --   V1 COERÊNCIA DA DECLARAÇÃO
  --      TIPO=TODOS exige 2+ tipos distintos. É o caso real de 01/10 18:14:
  --      22 linhas, 100% `Acordo`, declarado TIPO=TODOS, contra uma carteira de
  --      47.949 títulos com 0,8% de `Acordo`.
  --      TIPO=ACORDO exige que toda linha seja do rótulo `Acordo`.
  --
  --   V2 IGUALDADE DE CONJUNTO CONTRA O BASELINE
  --      o conjunto de `tipo_boleto_id` tem de ser IDÊNTICO ao do baseline.
  --      Por id de rótulo, não por texto: a base tem mojibake real
  --      ("Cursos de GraduaÁ„o Presencial", 1.124 títulos; "Extens„o", 4).
  --      Divergência é falha CONSERVADORA: não compara, não promove.
  -- =====================================================================
  select array_agg(distinct p.tipo_boleto_id order by p.tipo_boleto_id)
    into v_tipos
    from public.titulo_presenca_importacao p
   where p.escopo_id = p_escopo_id and p.tipo_boleto_id is not null;

  v_tipo_declarado := nullif(split_part(v_e.scope_key, 'TIPO=', 2), '');

  if v_tipo_declarado = 'TODOS' and coalesce(array_length(v_tipos,1),0) < 2 then
    v_bloqueio := format(
      'declaracao TIPO=TODOS incompativel com o conteudo: %s tipo(s) distinto(s) no arquivo',
      coalesce(array_length(v_tipos,1),0));
  elsif v_tipo_declarado = 'ACORDO'
        and exists (select 1 from public.titulo_presenca_importacao p
                     join public.extracao_rotulo r on r.id = p.tipo_boleto_id
                    where p.escopo_id = p_escopo_id and upper(r.valor) <> 'ACORDO') then
    v_bloqueio := 'declaracao TIPO=ACORDO incompativel com o conteudo: ha linha de outro tipo';
  end if;

  if v_bloqueio is null then
    select e.id, array_agg(distinct p.tipo_boleto_id order by p.tipo_boleto_id)
      into v_base_id, v_tipos_base
      from public.extracao_escopo e
      left join public.titulo_presenca_importacao p on p.escopo_id = e.id
                                                  and p.tipo_boleto_id is not null
     where e.source_type = v_e.source_type
       and e.scope_key   = v_e.scope_key
       and e.estado      = 'TOTAL_VALIDADO'
       and e.snapshot_at < v_e.snapshot_at
     group by e.id, e.snapshot_at
     order by e.snapshot_at desc limit 1;

    if v_base_id is not null and v_tipos is distinct from v_tipos_base then
      v_bloqueio := 'conjunto de tipos difere do baseline: '
        || coalesce(array_length(v_tipos,1),0)::text || ' vs '
        || coalesce(array_length(v_tipos_base,1),0)::text || ' tipo(s)';
    end if;
  end if;

  v_aval   := public.extracao_avaliar_total(p_escopo_id);
  v_estado := v_aval->>'estado';

  -- perfil do arquivo, para a validacao manual ser informada e nao de fe
  v_aval := v_aval || jsonb_build_object(
    'portao_conteudo', jsonb_build_object(
      'tipo_declarado', v_tipo_declarado,
      'tipos_no_arquivo', coalesce(array_length(v_tipos,1),0),
      'baseline_comparado', v_base_id,
      'bloqueio', v_bloqueio),
    'perfil_conteudo', (
      select jsonb_build_object(
        'linhas', count(*),
        'pct_a_vencer', round(100.0*count(*) filter (where p.vencimento >= current_date)
                              / nullif(count(*),0), 2),
        'tipos', coalesce(jsonb_agg(distinct jsonb_build_object(
                   'tipo', r.valor, 'id', p.tipo_boleto_id)), '[]'::jsonb))
        from public.titulo_presenca_importacao p
        left join public.extracao_rotulo r on r.id = p.tipo_boleto_id
       where p.escopo_id = p_escopo_id));

  -- O portão DESFAZ, não só recusa: `registrar_presenca_extracao` já pode ter
  -- promovido no 1º lote. Só a promoção AUTOMÁTICA é desfeita; a trava de
  -- `validado_por <> 'automatico'` acima protege a decisão humana.
  if v_bloqueio is not null then
    v_estado := 'TOTAL_PENDENTE_VALIDACAO';
  end if;

  if v_estado = 'TOTAL_VALIDADO' then
    update public.extracao_escopo
       set estado = 'TOTAL_VALIDADO', validacao_motivo = v_aval,
           validado_por = 'automatico', validado_em = now()
     where id = p_escopo_id;
  elsif v_bloqueio is not null and v_e.estado = 'TOTAL_VALIDADO' then
    update public.extracao_escopo
       set estado = 'TOTAL_PENDENTE_VALIDACAO', validacao_motivo = v_aval,
           validado_por = null, validado_em = null
     where id = p_escopo_id;
  else
    update public.extracao_escopo set validacao_motivo = v_aval
     where id = p_escopo_id;
  end if;

  return jsonb_build_object('escopo_id', p_escopo_id,
    'linhas_capturadas', v_cap,
    'estado', (select estado from public.extracao_escopo where id = p_escopo_id),
    'avaliacao', v_aval);
end;
$$;

comment on function public.extracao_lote_fechar(uuid) is
  'I2: recalcula as metricas pela MESMA extracao_metricas_recalcular que '
  'registrar_presenca_extracao usa, aplica o PORTAO DE CONTEUDO e roda '
  'extracao_avaliar_total. Mesmos limiares do I1, nenhum novo. Divergencia de '
  'conteudo desfaz a promocao automatica, nunca reescreve a declaracao. '
  'Recusa sobrescrever decisao humana.';


-- ---------------------------------------------------------------------------
-- 6. ACL
--
-- As duas INTERNAS não recebem EXECUTE de ninguém além do dono: elas não têm
-- portão próprio, e um `authenticated` que as chamasse direto gravaria presença
-- sem passar por `usuario_e_gestao()`. Rodando de dentro de função SECURITY
-- DEFINER, os chamadores não precisam desse EXECUTE -- há teste que prova isso
-- executando `set local role authenticated`.
--
-- As duas de lote seguem o padrão da casa: portão interno, nunca revoke de
-- `authenticated` (o que precisa de revoke explícito é PUBLIC, porque
-- `authenticated` e `anon` são membros de PUBLIC).
-- ---------------------------------------------------------------------------
revoke all on function public.extracao_linhas_gravar(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.extracao_metricas_recalcular(uuid) from public, anon, authenticated;

revoke all on function public.extracao_lote_anexar(uuid,jsonb) from public, anon;
grant execute on function public.extracao_lote_anexar(uuid,jsonb) to authenticated;
revoke all on function public.extracao_lote_fechar(uuid) from public, anon;
grant execute on function public.extracao_lote_fechar(uuid) to authenticated;

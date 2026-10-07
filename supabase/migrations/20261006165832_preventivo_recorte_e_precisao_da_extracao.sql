-- PREVENTIVO: recorte dos indicadores e precisao da data de extracao.
--
-- TRES COISAS, TODAS DE LEITURA. Nenhuma linha e apagada, nenhum titulo sai da
-- carteira e a acao PREPARADA fica intocada.
--
-- 1. FORA DO RECORTE, NAO EXCLUIDO. A remessa que ja estava em producao entrou
--    ANTES da regra de origem existir, e carrega 3 titulos com `Vcto Origem`
--    em setembro (R$ 1.279,51) que as fotos novas recusam. Apagar seria perder
--    historico; deixar contando seria misturar competencia. Entao os
--    indicadores passam a aplicar A MESMA REGRA do importador -- titulo cuja
--    origem esta fora do periodo da carteira nao entra na conta -- e o retorno
--    diz quantos sao e por que, em `fora_do_recorte`. Eles continuam em
--    `prev_titulo`, em `prev_titulo_lote` e como destinatarios da acao.
--
-- 2. ENTRADAS COM TRES NOMES. "Entradas" sozinho era ambiguo e gerou dois
--    numeros diferentes para a mesma serie:
--      entradas_na_serie      -- apareceram depois da primeira foto  (151)
--      entradas_ainda_presentes -- dessas, as que estao na ultima    (138)
--      entradas_que_sairam      -- entraram e ja sairam              (13)
--
-- 3. DATA SEM HORA INVENTADA. Relatorio antigo nao tem hora comprovada. A
--    remessa passa a declarar `extraido_precisao` e, nas de mesma data, uma
--    `ordem_no_dia` EXPLICITA. A ordenacao usa (data, ordem_no_dia) -- nunca
--    um horario de fachada.
--
--    SAO TRES VALORES, nao dois, porque o que ja estava gravado nao se encaixa
--    em nenhum dos outros:
--      DATA_E_HORA    -- quem importou declarou que a hora e a da extracao
--      DATA           -- so o dia e conhecido; a hora gravada nao vale nada
--      NAO_COMPROVADA -- o que ja existia antes desta migration
--
--    NAO_COMPROVADA e o ponto delicado. O `extraido_em` dessas linhas veio de
--    `criado_em` -- o momento do UPLOAD. Dizer que upload e extracao sao a
--    mesma coisa seria uma afirmacao que ninguem fez e que nao da para checar.
--    Entao o horario original fica EXATAMENTE como esta, intocado, e a
--    precisao apenas registra que ele nao foi comprovado. Para efeito de prova
--    de sequencia, NAO_COMPROVADA vale o mesmo que DATA: nao prova nada dentro
--    do dia. Quem souber a hora de verdade corrige a linha; ate la o modulo
--    prefere ficar pendente a inventar uma certeza.
--
--    O DIA E O DE SAO PAULO. Toda comparacao e toda ordenacao convertem o
--    timestamptz para o dia em America/Sao_Paulo. Com `::date` cru o resultado
--    dependeria do timezone da sessao: uma foto das 23h30 de 05/10 (BRT) cai
--    em 06/10 numa sessao UTC, e aquela virada de dia FALSA passaria a
--    "provar" que a foto veio depois de um envio das 22h do dia 05.
--
--    CONSEQUENCIA ASSUMIDA: se a remessa e o envio caem no MESMO DIA e a hora
--    de algum dos dois nao e comprovada, nao da para afirmar que a foto veio
--    DEPOIS do envio. Nesse caso o resultado da acao fica PENDENTE -- nulo,
--    com `sequencia_nao_comprovada` -- em vez de ser calculado no escuro.

-- -----------------------------------------------------------------------------
-- 0. O DIA DA OPERACAO
-- -----------------------------------------------------------------------------
-- A operacao e em Porto Alegre e o relatorio sai no horario de Brasilia. O dia
-- de um instante e o dia EM America/Sao_Paulo -- nunca `::date` cru, que
-- devolve o dia em UTC quando a sessao esta em UTC (o CI esta).
create or replace function public.preventivo_dia(p timestamptz)
returns date
language sql
stable
set search_path to 'public'
as $$ select (p at time zone 'America/Sao_Paulo')::date $$;

comment on function public.preventivo_dia(timestamptz) is
  'Dia de um instante no fuso da operacao (America/Sao_Paulo). Existe para que '
  'a comparacao entre remessa e envio nao mude de resultado conforme o timezone '
  'da sessao que faz a consulta.';

-- -----------------------------------------------------------------------------
-- 0B. A CHAVE DE ORDENACAO DAS REMESSAS -- UMA SO, PARA TODAS AS FUNCOES
-- -----------------------------------------------------------------------------
-- Antes cada funcao ordenava de um jeito e os resultados nao fechavam:
--
--   * `preventivo_evolucao` usava (dia, ordem_no_dia, extraido_em). O terceiro
--     campo DESEMPATAVA EM SILENCIO com um horario que pode nao ser
--     comprovado -- exatamente o que esta migration existe para nao fazer.
--   * `preventivo_remessa_comparar` usava so (dia, ordem_no_dia). Duas fotos
--     com hora conhecida no mesmo dia nascem AMBAS com ordem_no_dia = 1, que e
--     o default da tela quando a hora e conhecida -- a tela nem pergunta a
--     ordem nesse caso. Resultado: 09h e 15h do mesmo dia empatavam, a de 15h
--     nao achava a de 09h como anterior e se dizia "primeira remessa".
--
-- A regra unica, agora:
--
--   1. o DIA (em Sao Paulo) manda;
--   2. dentro do dia, a `ordem_no_dia` declarada manda;
--   3. no mesmo (dia, ordem), quem tem HORA COMPROVADA vem antes de quem nao
--      tem, e entre duas comprovadas o horario declarado desempata -- isso nao
--      e desempate silencioso: a hora so e usada quando alguem afirmou que ela
--      e a da extracao;
--   4. se nem isso resolve, o `id`. E arbitrario, e e assumido como
--      arbitrario: duas fotos sem hora comprovada e com a MESMA ordem no dia
--      nao tem ordem conhecida. O `id` so garante que a resposta nao mude
--      entre duas consultas; nao se afirma que uma veio antes da outra. Para
--      efeito de PROVA de sequencia contra um envio, esse par continua
--      valendo nada -- quem decide isso e a regra de precisao, nao a ordem.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'preventivo_ordem_remessa'
                   and typnamespace = 'public'::regnamespace) then
    create type public.preventivo_ordem_remessa as (
      dia date, ordem_no_dia int, hora_rank int, hora timestamptz, desempate uuid);
  end if;
end $$;

create or replace function public.preventivo_ordem(
  p_extraido_em timestamptz, p_precisao text, p_ordem_no_dia int, p_id uuid)
returns public.preventivo_ordem_remessa
language sql
stable
set search_path to 'public'
as $$
  select row(
    public.preventivo_dia(p_extraido_em),
    coalesce(p_ordem_no_dia, 1),
    -- 0 = hora declarada, 1 = sem hora. Separar em faixas impede que o
    -- sentinela abaixo seja comparado contra um horario de verdade.
    case when p_precisao = 'DATA_E_HORA' then 0 else 1 end,
    case when p_precisao = 'DATA_E_HORA' then p_extraido_em
         else '-infinity'::timestamptz end,
    p_id
  )::public.preventivo_ordem_remessa
$$;

comment on function public.preventivo_ordem(timestamptz, text, int, uuid) is
  'Chave unica de ordenacao das remessas: (dia em Sao Paulo, ordem_no_dia, '
  'hora comprovada antes de hora ausente, horario declarado, id). Todas as '
  'funcoes de leitura ordenam e comparam por ela, para que nao haja duas '
  'respostas diferentes para a mesma pergunta. Horario NAO comprovado nunca '
  'entra no desempate.';

-- -----------------------------------------------------------------------------
-- 1. PRECISAO E ORDEM EXPLICITA NA REMESSA
-- -----------------------------------------------------------------------------
alter table public.prev_lote add column if not exists extraido_precisao text;
-- O horario ja gravado NAO e tocado. So se registra que ele nunca foi
-- comprovado como hora de extracao -- ele veio do upload.
update public.prev_lote set extraido_precisao = 'NAO_COMPROVADA' where extraido_precisao is null;
alter table public.prev_lote alter column extraido_precisao set default 'DATA_E_HORA';
alter table public.prev_lote alter column extraido_precisao set not null;

alter table public.prev_lote drop constraint if exists prev_lote_extraido_precisao_check;
alter table public.prev_lote add constraint prev_lote_extraido_precisao_check
  check (extraido_precisao in ('DATA', 'DATA_E_HORA', 'NAO_COMPROVADA'));

alter table public.prev_lote add column if not exists ordem_no_dia int;
update public.prev_lote set ordem_no_dia = 1 where ordem_no_dia is null;
alter table public.prev_lote alter column ordem_no_dia set default 1;
alter table public.prev_lote alter column ordem_no_dia set not null;

alter table public.prev_lote drop constraint if exists prev_lote_ordem_no_dia_check;
alter table public.prev_lote add constraint prev_lote_ordem_no_dia_check
  check (ordem_no_dia >= 1);

comment on column public.prev_lote.extraido_precisao is
  'DATA_E_HORA = quem importou declarou que o horario de `extraido_em` e o da '
  'extracao. DATA = so o dia e conhecido; a hora gravada NAO deve ser lida nem '
  'exibida. NAO_COMPROVADA = remessa anterior a esta migration: o horario e o '
  'do upload e segue gravado como estava, mas ninguem afirmou que e o da '
  'extracao. Para prova de sequencia, NAO_COMPROVADA vale o mesmo que DATA. '
  'Em qualquer um dos dois, a ordem entre fotos do mesmo dia vem de '
  '`ordem_no_dia`.';
comment on column public.prev_lote.ordem_no_dia is
  'Ordem explicita entre remessas extraidas no MESMO dia, 1 = primeira. Existe '
  'para nao precisar inventar horario quando so se conhece a data.';

-- A remessa que ja existia fica NAO_COMPROVADA: o horario dela continua
-- gravado, intacto, mas e o do upload. Afirmar que upload e extracao
-- coincidem seria inventar um fato -- e justamente o que esta migration
-- existe para nao fazer.

create index if not exists prev_lote_ordem_idx
  on public.prev_lote (carteira_id, extraido_em, ordem_no_dia);

-- -----------------------------------------------------------------------------
-- 2. PRECISAO DO ENVIO NA ACAO
-- -----------------------------------------------------------------------------
alter table public.prev_acao add column if not exists envio_precisao text;
-- Mesma regra: o que ja estava gravado continua gravado, sem virar certeza.
update public.prev_acao set envio_precisao = 'NAO_COMPROVADA' where envio_precisao is null;
alter table public.prev_acao alter column envio_precisao set default 'DATA_E_HORA';
alter table public.prev_acao alter column envio_precisao set not null;

alter table public.prev_acao drop constraint if exists prev_acao_envio_precisao_check;
alter table public.prev_acao add constraint prev_acao_envio_precisao_check
  check (envio_precisao in ('DATA', 'DATA_E_HORA', 'NAO_COMPROVADA'));

comment on column public.prev_acao.envio_precisao is
  'DATA_E_HORA = a hora do envio foi declarada por quem registrou. DATA = so o '
  'dia. NAO_COMPROVADA = acao anterior a esta migration. Em DATA e em '
  'NAO_COMPROVADA a hora gravada nao deve ser exibida, e a comparacao com uma '
  'remessa do MESMO dia fica pendente, em vez de decidida por um horario que '
  'ninguem mediu.';

-- -----------------------------------------------------------------------------
-- 3. REGISTRAR ACAO EXTERNA COM PRECISAO
-- -----------------------------------------------------------------------------
-- A assinatura ganha `p_envio_precisao`. Com DEFAULT, manter a versao de 8
-- argumentos viva deixaria a chamada ambigua -- entao ela sai aqui, e nao
-- sobra ninguem chamando a antiga: a RPC so e usada pela tela do Preventivo.
drop function if exists public.preventivo_acao_externa_registrar(uuid, uuid, text, text, text, timestamptz, text[], boolean);

create or replace function public.preventivo_acao_externa_registrar(
  p_carteira_id uuid, p_lote_id uuid, p_nome text, p_canal text,
  p_contexto text, p_enviada_em timestamptz,
  p_matriculas text[] default null, p_remessa_inteira boolean default false,
  p_envio_precisao text default 'DATA_E_HORA')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_acao uuid; v_ctx text := upper(btrim(coalesce(p_contexto, '')));
  v_canal text := upper(btrim(coalesce(p_canal, ''))); v_extraido timestamptz;
  v_lista text[]; v_fora text[] := '{}'; v_publico text;
  v_prec text := upper(btrim(coalesce(p_envio_precisao, 'DATA_E_HORA')));
  v_lote_prec text;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_nome), '') = '' then
    raise exception 'Dê um nome à ação.' using errcode = '22023';
  end if;
  if v_canal not in ('WHATSAPP', 'EMAIL') then
    raise exception 'Canal inválido: use WHATSAPP ou EMAIL.' using errcode = '22023';
  end if;
  if v_ctx not in ('PROXIMO_VENCIMENTO', 'BOLETO_VENCIDO') then
    raise exception 'Contexto inválido: use PROXIMO_VENCIMENTO ou BOLETO_VENCIDO.' using errcode = '22023';
  end if;
  if v_prec not in ('DATA', 'DATA_E_HORA') then
    raise exception 'Precisão do envio inválida: use DATA ou DATA_E_HORA.' using errcode = '22023';
  end if;
  if p_enviada_em is null then
    raise exception 'Informe a data do envio.' using errcode = '22023';
  end if;
  if p_enviada_em > now() + interval '1 day' then
    raise exception 'O envio não pode estar no futuro.' using errcode = '22023';
  end if;

  select extraido_em, extraido_precisao into v_extraido, v_lote_prec
    from public.prev_lote
   where id = p_lote_id and carteira_id = p_carteira_id and status = 'CONFIRMADO';
  if v_extraido is null then
    raise exception 'Remessa não encontrada nesta carteira.' using errcode = '22023';
  end if;
  -- Sem hora comprovada dos DOIS lados, so o DIA pode ser cobrado -- e o dia
  -- e o de Sao Paulo, nao o da sessao. NAO_COMPROVADA conta como sem hora.
  if (v_prec <> 'DATA_E_HORA' or v_lote_prec <> 'DATA_E_HORA') then
    if public.preventivo_dia(p_enviada_em) < public.preventivo_dia(v_extraido) then
      raise exception 'O envio (%) é anterior à extração da remessa (%).',
        public.preventivo_dia(p_enviada_em), public.preventivo_dia(v_extraido)
        using errcode = '22023';
    end if;
  elsif p_enviada_em < v_extraido then
    raise exception 'O envio (%) é anterior à extração da remessa (%).', p_enviada_em, v_extraido
      using errcode = '22023';
  end if;

  v_lista := (select array_agg(distinct btrim(m)) from unnest(coalesce(p_matriculas, '{}')) m
               where btrim(coalesce(m, '')) <> '');
  if v_lista is null and not coalesce(p_remessa_inteira, false) then
    raise exception 'Informe quem recebeu: a lista de matrículas, ou confirme que o envio cobriu a remessa inteira.'
      using errcode = '22023';
  end if;
  if v_lista is not null and coalesce(p_remessa_inteira, false) then
    raise exception 'Escolha um: a lista de matrículas OU a remessa inteira.' using errcode = '22023';
  end if;
  v_publico := case when v_lista is null then 'remessa_inteira' else 'lista_informada' end;

  if v_lista is not null then
    select coalesce(array_agg(m order by m), '{}') into v_fora from (
      select m from unnest(v_lista) m
       except
      select t.matricula_prime
        from public.prev_titulo t
        join public.prev_titulo_lote tl on tl.titulo_id = t.id and tl.lote_id = p_lote_id
       where t.carteira_id = p_carteira_id) x;
  end if;

  insert into public.prev_acao (carteira_id, lote_id, nome, canal, contexto, filtros,
                                estado, origem, envio_precisao, criada_por,
                                exportada_em, envio_confirmado_em)
  values (p_carteira_id, p_lote_id, btrim(p_nome), v_canal, v_ctx,
          jsonb_build_object('lote_id', p_lote_id, 'publico', v_publico,
                             'matriculas_informadas', coalesce(array_length(v_lista, 1), 0),
                             'fora_da_remessa', coalesce(array_length(v_fora, 1), 0)),
          'ENVIO_CONFIRMADO', 'EXTERNA', v_prec,
          lower(coalesce(auth.jwt() ->> 'email', 'sistema')),
          p_enviada_em, p_enviada_em)
  returning id into v_acao;

  insert into public.prev_acao_destinatario (acao_id, titulo_id, matricula, aluno_nome, contato, incluido, motivo)
  select v_acao, t.id, t.matricula_prime, t.aluno_nome,
         case when v_canal = 'WHATSAPP' then t.celular_aluno else t.email_aluno end,
         true, null
    from public.prev_titulo t
    join public.prev_titulo_lote tl on tl.titulo_id = t.id and tl.lote_id = p_lote_id
   where t.carteira_id = p_carteira_id
     and (v_lista is null or t.matricula_prime = any(v_lista));

  if (select count(*) from public.prev_acao_destinatario where acao_id = v_acao) = 0 then
    raise exception 'Nenhuma das matrículas informadas está nesta remessa.' using errcode = '22023';
  end if;

  return public.preventivo_acao_resumo(v_acao) || jsonb_build_object(
    'fora_da_remessa', to_jsonb(v_fora),
    'fora_da_remessa_qtd', coalesce(array_length(v_fora, 1), 0),
    'matriculas_informadas', coalesce(array_length(v_lista, 1), 0),
    'envio_precisao', v_prec);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. IMPORTAR COM PRECISAO E ORDEM NO DIA
-- -----------------------------------------------------------------------------
-- Mesmo motivo: a v2 ganha precisao e ordem no dia, entao a de 7 argumentos
-- sai para nao deixar a chamada ambigua. A v1 (6 argumentos) continua viva --
-- e ela que faz a importacao de verdade; a v2 so delega e carimba.
drop function if exists public.preventivo_lote_confirmar_v2(uuid, text, text, jsonb, text, jsonb, timestamptz);

create or replace function public.preventivo_lote_confirmar_v2(
  p_carteira_id uuid, p_nome text, p_arquivo text, p_mapeamento jsonb,
  p_conteudo_hash text, p_linhas jsonb, p_extraido_em timestamptz,
  p_precisao text default 'DATA_E_HORA', p_ordem_no_dia int default 1)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_lote uuid; v_prec text := upper(btrim(coalesce(p_precisao, 'DATA_E_HORA')));
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if p_extraido_em is null then
    raise exception 'Informe a data em que o relatório foi extraído.' using errcode = '22023';
  end if;
  if p_extraido_em > now() + interval '1 day' then
    raise exception 'A extração não pode estar no futuro.' using errcode = '22023';
  end if;
  if v_prec not in ('DATA', 'DATA_E_HORA') then
    raise exception 'Precisão inválida: use DATA ou DATA_E_HORA.' using errcode = '22023';
  end if;
  if coalesce(p_ordem_no_dia, 1) < 1 then
    raise exception 'A ordem no dia começa em 1.' using errcode = '22023';
  end if;

  v := public.preventivo_lote_confirmar(p_carteira_id, p_nome, p_arquivo,
                                        p_mapeamento, p_conteudo_hash, p_linhas);
  v_lote := (v->>'lote_id')::uuid;
  update public.prev_lote
     set extraido_em = p_extraido_em,
         extraido_precisao = v_prec,
         ordem_no_dia = coalesce(p_ordem_no_dia, 1)
   where id = v_lote;

  return v || jsonb_build_object('extraido_em', p_extraido_em,
                                 'extraido_precisao', v_prec,
                                 'ordem_no_dia', coalesce(p_ordem_no_dia, 1));
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. O RECORTE DOS INDICADORES
-- -----------------------------------------------------------------------------
-- Mesma regra do importador, agora tambem na leitura: titulo cuja ORIGEM esta
-- fora do periodo da carteira nao entra na conta. Nao apaga nada.
create or replace function public.preventivo_no_recorte(p_titulo_id uuid)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select t.vencimento_origem is null
      or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate)
    from public.prev_titulo t
    join public.prev_carteira c on c.id = t.carteira_id
   where t.id = p_titulo_id;
$$;

-- -----------------------------------------------------------------------------
-- 6. EVOLUCAO: recorte, tres rotulos de entrada e ordem explicita
-- -----------------------------------------------------------------------------
create or replace function public.preventivo_evolucao(p_carteira_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_primeiro uuid; v_ultimo uuid;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select id into v_primeiro from public.prev_lote
   where carteira_id = p_carteira_id and status = 'CONFIRMADO'
   order by public.preventivo_ordem(extraido_em, extraido_precisao, ordem_no_dia, id) limit 1;
  select id into v_ultimo from public.prev_lote
   where carteira_id = p_carteira_id and status = 'CONFIRMADO'
   order by public.preventivo_ordem(extraido_em, extraido_precisao, ordem_no_dia, id) desc limit 1;

  with carteira as (select venc_de, venc_ate from public.prev_carteira where id = p_carteira_id),
  -- O RECORTE: titulo da carteira cuja origem cabe no periodo dela.
  dentro as (
    select t.id
      from public.prev_titulo t, carteira c
     where t.carteira_id = p_carteira_id
       and (t.vencimento_origem is null
            or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate))
  ), fora as (
    select t.id, t.matricula_prime, t.vencimento_origem
      from public.prev_titulo t, carteira c
     where t.carteira_id = p_carteira_id
       and t.vencimento_origem is not null
       and (t.vencimento_origem < c.venc_de or t.vencimento_origem > c.venc_ate)
  ), remessas as (
    select l.id, l.nome, l.extraido_em, l.extraido_precisao, l.ordem_no_dia,
           row_number() over (order by public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.id)) as ordem
      from public.prev_lote l
     where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
  ), tl as (
    select x.lote_id, x.titulo_id, x.saldo_na_remessa
      from public.prev_titulo_lote x
      join dentro d on d.id = x.titulo_id
  ), foto as (
    select r.*,
           (select count(*) from tl where tl.lote_id = r.id) as titulos,
           (select count(distinct t.matricula_prime) from tl
              join public.prev_titulo t on t.id = tl.titulo_id
             where tl.lote_id = r.id) as alunos,
           (select coalesce(sum(saldo_na_remessa), 0) from tl where tl.lote_id = r.id) as saldo
      from remessas r
  ), com_anterior as (
    select f.*, lag(f.id) over (order by f.ordem) as anterior from foto f
  ), linhas as (
    select c.*,
           case when c.anterior is null then null else (
             select count(*) from tl a where a.lote_id = c.anterior
               and not exists (select 1 from tl b where b.lote_id = c.id and b.titulo_id = a.titulo_id)) end as saiu_titulos,
           case when c.anterior is null then null else (
             select coalesce(sum(a.saldo_na_remessa), 0) from tl a where a.lote_id = c.anterior
               and not exists (select 1 from tl b where b.lote_id = c.id and b.titulo_id = a.titulo_id)) end as saiu_valor,
           case when c.anterior is null then null else (
             select count(*) from tl b where b.lote_id = c.id
               and not exists (select 1 from tl a where a.lote_id = c.anterior and a.titulo_id = b.titulo_id)) end as entraram
      from com_anterior c
  ), acoes as (
    select a.id, a.nome, a.canal, a.contexto, a.origem, a.lote_id, a.estado,
           a.envio_confirmado_em, a.envio_precisao, a.filtros->>'publico' as publico,
           l.extraido_em as remessa_em, l.extraido_precisao as remessa_precisao,
           (select count(*) from public.prev_acao_destinatario d
             join dentro dd on dd.id = d.titulo_id
            where d.acao_id = a.id and d.incluido) as base_titulos,
           (select count(distinct d.matricula) from public.prev_acao_destinatario d
             join dentro dd on dd.id = d.titulo_id
            where d.acao_id = a.id and d.incluido) as base_alunos,
           (select coalesce(sum(x.saldo_na_remessa), 0)
              from public.prev_acao_destinatario d
              join tl x on x.titulo_id = d.titulo_id and x.lote_id = a.lote_id
             where d.acao_id = a.id and d.incluido) as base_saldo,
           (select count(*) from public.prev_acao_destinatario d
             where d.acao_id = a.id and d.incluido
               and not exists (select 1 from dentro dd where dd.id = d.titulo_id)) as base_fora_do_recorte
      from public.prev_acao a
      join public.prev_lote l on l.id = a.lote_id
     where a.carteira_id = p_carteira_id and a.cancelada_em is null
  ), acoes_regua as (
    select ac.*,
      -- A REGUA SO VALE SE A SEQUENCIA FOR COMPROVADA. Dia posterior basta.
      -- Mesmo dia so conta com hora comprovada dos DOIS lados; senao, pendente.
      (select l.id from public.prev_lote l
        where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
          and ac.envio_confirmado_em is not null
          and (public.preventivo_dia(l.extraido_em) > public.preventivo_dia(ac.envio_confirmado_em)
               or (public.preventivo_dia(l.extraido_em) = public.preventivo_dia(ac.envio_confirmado_em)
                   and l.extraido_precisao = 'DATA_E_HORA' and ac.envio_precisao = 'DATA_E_HORA'
                   and l.extraido_em > ac.envio_confirmado_em))
        order by public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.id) desc limit 1) as ultima_depois,
      (select count(*) from public.prev_lote l
        where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
          and ac.envio_confirmado_em is not null
          and (public.preventivo_dia(l.extraido_em) > public.preventivo_dia(ac.envio_confirmado_em)
               or (public.preventivo_dia(l.extraido_em) = public.preventivo_dia(ac.envio_confirmado_em)
                   and l.extraido_precisao = 'DATA_E_HORA' and ac.envio_precisao = 'DATA_E_HORA'
                   and l.extraido_em > ac.envio_confirmado_em))) as atualizacoes,
      -- Existe foto no MESMO dia que so nao pode ser usada por falta de hora?
      (select count(*) > 0 from public.prev_lote l
        where l.carteira_id = p_carteira_id and l.status = 'CONFIRMADO'
          and ac.envio_confirmado_em is not null
          and public.preventivo_dia(l.extraido_em) = public.preventivo_dia(ac.envio_confirmado_em)
          and (l.extraido_precisao <> 'DATA_E_HORA'
               or ac.envio_precisao <> 'DATA_E_HORA')) as sequencia_nao_comprovada
      from acoes ac
  ), acoes_m as (
    select ac.*,
           case when ac.ultima_depois is null then null else (
             select count(*) from public.prev_acao_destinatario d
              join dentro dd on dd.id = d.titulo_id
              where d.acao_id = ac.id and d.incluido
                and not exists (select 1 from tl n where n.lote_id = ac.ultima_depois and n.titulo_id = d.titulo_id)) end as saiu_titulos,
           case when ac.ultima_depois is null then null else (
             select coalesce(sum(x.saldo_na_remessa), 0)
               from public.prev_acao_destinatario d
               join tl x on x.titulo_id = d.titulo_id and x.lote_id = ac.lote_id
              where d.acao_id = ac.id and d.incluido
                and not exists (select 1 from tl n where n.lote_id = ac.ultima_depois and n.titulo_id = d.titulo_id)) end as saiu_valor,
           case when ac.ultima_depois is null then null else (
             select count(*) from (
               select d.matricula from public.prev_acao_destinatario d
                join dentro dd on dd.id = d.titulo_id
                where d.acao_id = ac.id and d.incluido
                group by d.matricula
               having count(*) filter (where exists (
                        select 1 from tl n where n.lote_id = ac.ultima_depois and n.titulo_id = d.titulo_id)) = 0) y) end as saiu_alunos
      from acoes_regua ac
  )
  select jsonb_build_object(
    'pontos', coalesce((select jsonb_agg(jsonb_build_object(
        'remessa', l.id, 'nome', l.nome, 'extraido_em', l.extraido_em,
        'extraido_precisao', l.extraido_precisao, 'ordem_no_dia', l.ordem_no_dia,
        'ordem', l.ordem,
        'titulos', l.titulos, 'alunos', l.alunos, 'saldo', l.saldo,
        'saiu_da_base_titulos', l.saiu_titulos, 'saiu_da_base_valor', l.saiu_valor,
        'entraram', l.entraram
      ) order by l.ordem) from linhas l), '[]'::jsonb),
    'acoes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'nome', m.nome, 'canal', m.canal, 'contexto', m.contexto,
        'origem', m.origem, 'estado', m.estado, 'publico', m.publico, 'remessa', m.lote_id,
        'remessa_nome', (select l.nome from public.prev_lote l where l.id = m.lote_id),
        'enviada_em', m.envio_confirmado_em, 'envio_precisao', m.envio_precisao,
        'base_titulos', m.base_titulos, 'base_alunos', m.base_alunos, 'base_saldo', m.base_saldo,
        'base_fora_do_recorte', m.base_fora_do_recorte,
        'atualizacoes_depois', m.atualizacoes,
        'comparado_com', m.ultima_depois,
        'sequencia_nao_comprovada', m.sequencia_nao_comprovada,
        'saiu_titulos', m.saiu_titulos, 'saiu_alunos', m.saiu_alunos, 'saiu_valor', m.saiu_valor,
        'em_aberto', case when m.ultima_depois is null then null else m.base_titulos - m.saiu_titulos end,
        'taxa_titulos', case when m.ultima_depois is null or m.base_titulos = 0 then null
                             else round((m.saiu_titulos::numeric / m.base_titulos) * 100, 1) end,
        'taxa_alunos', case when m.ultima_depois is null or m.base_alunos = 0 then null
                            else round((m.saiu_alunos::numeric / m.base_alunos) * 100, 1) end,
        'taxa_valor', case when m.ultima_depois is null or m.base_saldo = 0 then null
                           else round((m.saiu_valor / m.base_saldo) * 100, 1) end,
        'sem_envio_confirmado', (m.envio_confirmado_em is null)
      ) order by m.envio_confirmado_em nulls last) from acoes_m m), '[]'::jsonb),
    'cards', jsonb_build_object(
      'alunos_acionados', (
        select count(distinct d.matricula) from public.prev_acao_destinatario d
          join public.prev_acao a on a.id = d.acao_id
          join dentro dd on dd.id = d.titulo_id
         where a.carteira_id = p_carteira_id and a.cancelada_em is null
           and a.envio_confirmado_em is not null and d.incluido),
      'saldo_inicial', (select coalesce(sum(saldo_na_remessa), 0) from tl where lote_id = v_primeiro),
      'titulos_inicial', (select count(*) from tl where lote_id = v_primeiro),
      'saldo_ainda_aberto', (select coalesce(sum(saldo_na_remessa), 0) from tl where lote_id = v_ultimo),
      'titulos_ainda_abertos', (select count(*) from tl where lote_id = v_ultimo),
      'saiu_da_base_titulos', case when v_primeiro = v_ultimo then 0 else (
        select count(*) from tl a where a.lote_id = v_primeiro
          and not exists (select 1 from tl b where b.lote_id = v_ultimo and b.titulo_id = a.titulo_id)) end,
      'saiu_da_base_valor', case when v_primeiro = v_ultimo then 0 else (
        select coalesce(sum(a.saldo_na_remessa), 0) from tl a where a.lote_id = v_primeiro
          and not exists (select 1 from tl b where b.lote_id = v_ultimo and b.titulo_id = a.titulo_id)) end,
      -- OS TRES ROTULOS DE ENTRADA, que antes vinham com um nome so.
      'entradas_na_serie', case when v_primeiro = v_ultimo then 0 else (
        select count(distinct x.titulo_id) from tl x
         where not exists (select 1 from tl a where a.lote_id = v_primeiro and a.titulo_id = x.titulo_id)) end,
      'entradas_ainda_presentes', case when v_primeiro = v_ultimo then 0 else (
        select count(*) from tl b where b.lote_id = v_ultimo
          and not exists (select 1 from tl a where a.lote_id = v_primeiro and a.titulo_id = b.titulo_id)) end,
      'entradas_que_sairam', case when v_primeiro = v_ultimo then 0 else (
        (select count(distinct x.titulo_id) from tl x
          where not exists (select 1 from tl a where a.lote_id = v_primeiro and a.titulo_id = x.titulo_id))
        - (select count(*) from tl b where b.lote_id = v_ultimo
            and not exists (select 1 from tl a where a.lote_id = v_primeiro and a.titulo_id = b.titulo_id))) end,
      'primeira_extracao', (select extraido_em from public.prev_lote where id = v_primeiro),
      'primeira_precisao', (select extraido_precisao from public.prev_lote where id = v_primeiro),
      'ultima_extracao', (select extraido_em from public.prev_lote where id = v_ultimo),
      'ultima_precisao', (select extraido_precisao from public.prev_lote where id = v_ultimo),
      'remessas', (select count(*) from linhas)),
    'fora_do_recorte', jsonb_build_object(
      'motivo', 'ORIGEM_FORA_DO_PERIODO',
      'titulos', (select count(*) from fora),
      'valor', (select coalesce(sum(x.saldo_na_remessa), 0) from public.prev_titulo_lote x
                 where x.lote_id = v_ultimo and exists (select 1 from fora f where f.id = x.titulo_id)),
      'matriculas', coalesce((select jsonb_agg(f.matricula_prime order by f.matricula_prime) from fora f), '[]'::jsonb),
      'observacao', 'Títulos com vencimento de origem fora do período da carteira. '
                 || 'Continuam na carteira e no histórico -- apenas não entram nos indicadores.'),
    'definicao', 'SAIU DA BASE = o título estava na primeira foto e não está na última. '
              || 'NÃO é pagamento confirmado. Os cards comparam TÍTULO A TÍTULO. '
              || 'ENTRADAS NA SÉRIE = apareceram depois da primeira foto; ENTRADAS AINDA '
              || 'PRESENTES = dessas, as que estão na última; ENTRADAS QUE SAÍRAM = a '
              || 'diferença. Ação cuja remessa seguinte está no MESMO dia do envio, sem '
              || 'hora comprovada dos dois lados, fica com resultado PENDENTE.'
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6B. COMPARACAO ENTRE REMESSAS: mesmo recorte, ordem explicita
-- -----------------------------------------------------------------------------
-- Duas mudancas, nenhuma na conta em si: (a) so entram titulos dentro do
-- recorte; (b) "remessa anterior" deixa de ser decidida por `extraido_em` cru
-- e passa a usar (dia, ordem_no_dia) -- duas fotos do mesmo dia tem ordem
-- declarada, nao horario presumido.
create or replace function public.preventivo_remessa_comparar(p_lote_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_carteira uuid; v_anterior uuid; v_quando timestamptz;
        v_ordem int; v_prec text; v_chave public.preventivo_ordem_remessa;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select carteira_id, extraido_em, ordem_no_dia, extraido_precisao
    into v_carteira, v_quando, v_ordem, v_prec
    from public.prev_lote where id = p_lote_id;
  v_chave := public.preventivo_ordem(v_quando, v_prec, v_ordem, p_lote_id);
  if v_carteira is null then
    raise exception 'Remessa não encontrada.' using errcode = '22023';
  end if;

  select id into v_anterior from public.prev_lote
   where carteira_id = v_carteira and status = 'CONFIRMADO'
     and public.preventivo_ordem(extraido_em, extraido_precisao, ordem_no_dia, id) < v_chave
   order by public.preventivo_ordem(extraido_em, extraido_precisao, ordem_no_dia, id) desc
   limit 1;

  if v_anterior is null then
    return jsonb_build_object('remessa', p_lote_id, 'remessa_anterior', null,
      'primeira_remessa', true,
      'observacao', 'Primeira remessa da carteira: não há anterior para comparar.');
  end if;

  with dentro as (
    select x.lote_id, x.titulo_id, x.saldo_na_remessa
      from public.prev_titulo_lote x
      join public.prev_titulo t on t.id = x.titulo_id
      join public.prev_carteira c on c.id = t.carteira_id
     where t.carteira_id = v_carteira
       and (t.vencimento_origem is null
            or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate))
  ), fora as (
    select x.lote_id, x.saldo_na_remessa
      from public.prev_titulo_lote x
      join public.prev_titulo t on t.id = x.titulo_id
      join public.prev_carteira c on c.id = t.carteira_id
     where t.carteira_id = v_carteira
       and t.vencimento_origem is not null
       and (t.vencimento_origem < c.venc_de or t.vencimento_origem > c.venc_ate)
  )
  select jsonb_build_object(
    'remessa', p_lote_id,
    'remessa_anterior', v_anterior,
    'primeira_remessa', false,
    'continua_em_aberto', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(ant.saldo_na_remessa), 0))
        from dentro ant
       where ant.lote_id = v_anterior
         and exists (select 1 from dentro novo
                      where novo.lote_id = p_lote_id and novo.titulo_id = ant.titulo_id)),
    'saiu_da_base', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(ant.saldo_na_remessa), 0))
        from dentro ant
       where ant.lote_id = v_anterior
         and not exists (select 1 from dentro novo
                          where novo.lote_id = p_lote_id and novo.titulo_id = ant.titulo_id)),
    'regularizados_entre_remessas', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(ant.saldo_na_remessa), 0))
        from dentro ant
       where ant.lote_id = v_anterior
         and not exists (select 1 from dentro novo
                          where novo.lote_id = p_lote_id and novo.titulo_id = ant.titulo_id)),
    'novos_na_remessa', (
      select jsonb_build_object('titulos', count(*), 'valor', coalesce(sum(novo.saldo_na_remessa), 0))
        from dentro novo
       where novo.lote_id = p_lote_id
         and not exists (select 1 from dentro ant
                          where ant.lote_id = v_anterior and ant.titulo_id = novo.titulo_id)),
    'fora_do_recorte', (
      select jsonb_build_object('motivo', 'ORIGEM_FORA_DO_PERIODO',
                                'titulos', count(*), 'valor', coalesce(sum(f.saldo_na_remessa), 0))
        from fora f where f.lote_id = p_lote_id),
    'definicao', 'SAIU DA BASE = título que estava na remessa anterior e deixou de '
              || 'aparecer no relatório seguinte. NÃO é pagamento confirmado: pode ser '
              || 'pagamento, cancelamento, renegociação, bolsa ou mudança do recorte do '
              || 'relatório. A fonte não distingue. Títulos com vencimento de origem fora '
              || 'do período da carteira não entram na conta -- aparecem em fora_do_recorte.'
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6C. RESULTADO DA ACAO: recorte e, sem sequencia comprovada, PENDENTE
-- -----------------------------------------------------------------------------
-- A regra que muda o numero: a remessa so serve de regua se ficar PROVADO que
-- ela veio depois do envio. Dia posterior prova. Mesmo dia so prova se os dois
-- lados tiverem hora comprovada (DATA_E_HORA). Se a unica foto candidata e do
-- mesmo dia e alguem ali so tem a data, o resultado fica NULO e a resposta diz
-- `sequencia_nao_comprovada` -- preferimos nao responder a responder no escuro.
create or replace function public.preventivo_acao_resultado(p_acao_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v jsonb; v_lote uuid; v_carteira uuid; v_seguinte uuid;
  v_titulos int; v_saiu int; v_ancora timestamptz; v_seguinte_em timestamptz;
  v_alunos int; v_alunos_saiu int; v_valor numeric; v_valor_saiu numeric;
  v_origem text; v_prec text; v_pendente boolean := false; v_fora int;
  v_dia_ancora date;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select a.lote_id, a.carteira_id, a.envio_confirmado_em, a.origem, a.envio_precisao
    into v_lote, v_carteira, v_ancora, v_origem, v_prec
    from public.prev_acao a where a.id = p_acao_id;
  if v_lote is null then
    return jsonb_build_object('acao', p_acao_id, 'sem_remessa', true,
      'observacao', 'Ação sem remessa vinculada: não há o que comparar.');
  end if;

  if v_ancora is not null then
    v_dia_ancora := public.preventivo_dia(v_ancora);
    select l.id, l.extraido_em into v_seguinte, v_seguinte_em
      from public.prev_lote l
     where l.carteira_id = v_carteira and l.status = 'CONFIRMADO'
       and (public.preventivo_dia(l.extraido_em) > v_dia_ancora
            or (public.preventivo_dia(l.extraido_em) = v_dia_ancora
                and l.extraido_precisao = 'DATA_E_HORA' and v_prec = 'DATA_E_HORA'
                and l.extraido_em > v_ancora))
     order by public.preventivo_ordem(l.extraido_em, l.extraido_precisao, l.ordem_no_dia, l.id) limit 1;

    -- Existe foto no mesmo dia que ficou de fora SO por falta de hora?
    select count(*) > 0 into v_pendente from public.prev_lote l
     where l.carteira_id = v_carteira and l.status = 'CONFIRMADO'
       and public.preventivo_dia(l.extraido_em) = v_dia_ancora
       and (l.extraido_precisao <> 'DATA_E_HORA' or v_prec <> 'DATA_E_HORA');
  end if;

  select count(*), count(distinct d.matricula) into v_titulos, v_alunos
    from public.prev_acao_destinatario d
    join public.prev_titulo t on t.id = d.titulo_id
    join public.prev_carteira c on c.id = t.carteira_id
   where d.acao_id = p_acao_id and d.incluido
     and (t.vencimento_origem is null
          or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate));

  select count(*) into v_fora
    from public.prev_acao_destinatario d
    join public.prev_titulo t on t.id = d.titulo_id
    join public.prev_carteira c on c.id = t.carteira_id
   where d.acao_id = p_acao_id and d.incluido
     and t.vencimento_origem is not null
     and (t.vencimento_origem < c.venc_de or t.vencimento_origem > c.venc_ate);

  select count(*) into v_saiu
    from public.prev_acao_destinatario d
    join public.prev_titulo t on t.id = d.titulo_id
    join public.prev_carteira c on c.id = t.carteira_id
   where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     and (t.vencimento_origem is null
          or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate))
     and not exists (select 1 from public.prev_titulo_lote n
                      where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id);

  select count(*) into v_alunos_saiu from (
    select d.matricula
      from public.prev_acao_destinatario d
      join public.prev_titulo t on t.id = d.titulo_id
      join public.prev_carteira c on c.id = t.carteira_id
     where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
       and (t.vencimento_origem is null
            or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate))
     group by d.matricula
    having count(*) filter (where exists (
             select 1 from public.prev_titulo_lote n
              where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id)) = 0
  ) x;

  select coalesce(sum(tl.saldo_na_remessa), 0) into v_valor
    from public.prev_acao_destinatario d
    join public.prev_titulo_lote tl on tl.titulo_id = d.titulo_id and tl.lote_id = v_lote
    join public.prev_titulo t on t.id = d.titulo_id
    join public.prev_carteira c on c.id = t.carteira_id
   where d.acao_id = p_acao_id and d.incluido
     and (t.vencimento_origem is null
          or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate));

  select coalesce(sum(tl.saldo_na_remessa), 0) into v_valor_saiu
    from public.prev_acao_destinatario d
    join public.prev_titulo_lote tl on tl.titulo_id = d.titulo_id and tl.lote_id = v_lote
    join public.prev_titulo t on t.id = d.titulo_id
    join public.prev_carteira c on c.id = t.carteira_id
   where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     and (t.vencimento_origem is null
          or (t.vencimento_origem >= c.venc_de and t.vencimento_origem <= c.venc_ate))
     and not exists (select 1 from public.prev_titulo_lote n
                      where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id);

  select jsonb_build_object(
    'acao', p_acao_id,
    'origem', v_origem,
    'remessa', v_lote,
    'remessa_seguinte', v_seguinte,
    'remessa_seguinte_em', v_seguinte_em,
    'comparado_a_partir_de', v_ancora,
    'envio_precisao', v_prec,
    'sequencia_nao_comprovada', coalesce(v_pendente, false),
    'resultado_pendente', (v_seguinte is null),
    'aguardando_envio_confirmado', (v_ancora is null),
    'alunos_acionados', v_alunos,
    'titulos_acionados', v_titulos,
    'valor_acionado', v_valor,
    'fora_do_recorte', jsonb_build_object('motivo', 'ORIGEM_FORA_DO_PERIODO', 'titulos', v_fora),
    'continuam_em_aberto', case when v_seguinte is null then null else v_titulos - v_saiu end,
    'regularizados_entre_remessas', case when v_seguinte is null then null else v_saiu end,
    'saiu_da_base', case when v_seguinte is null then null else v_saiu end,
    'alunos_regularizados', case when v_seguinte is null then null else v_alunos_saiu end,
    'alunos_que_sairam', case when v_seguinte is null then null else v_alunos_saiu end,
    'valor_regularizado', case when v_seguinte is null then null else v_valor_saiu end,
    'taxa_regularizacao', case when v_seguinte is null or v_titulos = 0 then null
                               else round((v_saiu::numeric / v_titulos) * 100, 1) end,
    'taxa_regularizacao_alunos', case when v_seguinte is null or v_alunos = 0 then null
                               else round((v_alunos_saiu::numeric / v_alunos) * 100, 1) end,
    'taxa_regularizacao_valor', case when v_seguinte is null or v_valor = 0 then null
                               else round((v_valor_saiu / v_valor) * 100, 1) end,
    'aguardando_proxima_remessa', (v_ancora is not null and v_seguinte is null and not coalesce(v_pendente, false)),
    'definicao', 'SAIU DA BASE = o título acionado não voltou na primeira remessa '
              || 'COMPROVADAMENTE extraída depois do envio. NÃO é pagamento confirmado. '
              || 'O valor usa o saldo do título NA REMESSA em que ele foi acionado. '
              || 'Aluno que saiu = NENHUM título dele voltou. Títulos com origem fora do '
              || 'período da carteira não entram na conta. Se a única foto candidata é do '
              || 'mesmo dia do envio e falta hora comprovada, o resultado fica pendente.'
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. PRIVILEGIOS
-- -----------------------------------------------------------------------------
revoke all on function public.preventivo_lote_confirmar_v2(uuid, text, text, jsonb, text, jsonb, timestamptz, text, int) from public, anon;
revoke all on function public.preventivo_acao_externa_registrar(uuid, uuid, text, text, text, timestamptz, text[], boolean, text) from public, anon;
revoke all on function public.preventivo_no_recorte(uuid) from public, anon;
revoke all on function public.preventivo_dia(timestamptz) from public, anon;
revoke all on function public.preventivo_ordem(timestamptz, text, int, uuid) from public, anon;
grant execute on function public.preventivo_lote_confirmar_v2(uuid, text, text, jsonb, text, jsonb, timestamptz, text, int) to authenticated;
grant execute on function public.preventivo_acao_externa_registrar(uuid, uuid, text, text, text, timestamptz, text[], boolean, text) to authenticated;
grant execute on function public.preventivo_no_recorte(uuid) to authenticated;
grant execute on function public.preventivo_dia(timestamptz) to authenticated;
grant execute on function public.preventivo_ordem(timestamptz, text, int, uuid) to authenticated;

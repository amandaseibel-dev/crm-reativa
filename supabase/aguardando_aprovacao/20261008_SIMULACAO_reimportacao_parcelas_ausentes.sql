-- =====================================================================
-- 20261008 — SIMULACAO: REPROCESSAR ARQUIVOS DE MENSALIDADE
--
-- Origem declarada pela gestao em 08/10/2026: "a ideia e reprocessar os
-- arquivos" e "arquivo e apenas de mensalidades, nao tera acordos".
--
-- NAO ESCREVE EM NENHUMA TABELA DE PRODUCAO. A unica gravacao e a TEMP
-- TABLE do BLOCO 1, que e local a sessao, morre no disconnect e nao toca
-- nada permanente. Os BLOCOS A-E sao 100% SELECT.
--
-- O QUE ESTA SIMULACAO RESPONDE
--   1. Quais linhas do arquivo ja existem, quais estao protegidas, quais
--      estao realmente ausentes e quais tem chave nao confiavel.
--   2. **O QUE UM REPROCESSO CEGO PELA TELA DE BORDEROS FARIA** — o
--      BLOCO B mede o dano antes de ele acontecer. Leia o BLOCO B antes
--      de qualquer decisao.
--
-- POR QUE A TELA DE ACORDOS NAO SERVE PARA ESTE ARQUIVO
--   ImportacaoAcordos.jsx:125 descarta toda linha com
--   `Tipo de Boleto <> 'Acordo'`, e em seguida (linha 143) recusa o
--   arquivo inteiro com "Nenhuma parcela de Acordo encontrada". Um
--   arquivo so de mensalidade nao passa dessa tela -- nem gera trilha de
--   presenca, porque a presenca so e gravada dentro de `importar()`.
--   O caminho real da mensalidade e o BORDERO (Borderos.jsx).
--
-- PRECEDENCIA DA CLASSIFICACAO (ordem fixa)
--   DIVERGENTE > PROTEGIDA > JA_EXISTENTE > AUSENTE_ELEGIVEL
-- =====================================================================


-- ---------- BLOCO 0: pre-voo — as colunas usadas existem? ----------
-- Qualquer linha 'FALTA' invalida a consulta. Pare e ajuste.
select 'pre-voo' as bloco, t.tabela, t.coluna,
       case when c.column_name is null then 'FALTA' else 'ok' end as situacao
  from (values
        ('acordos_titulos','documento'),('acordos_titulos','situacao'),
        ('acordos_titulos','status'),('acordos_titulos','valor_original'),
        ('acordos_titulos','saldo_corrigido'),('acordos_titulos','valor_em_aberto'),
        ('acordos_titulos','valor_cobranca_ajustado'),('acordos_titulos','tipo_boleto'),
        ('acordos_titulos','aluno_id'),('acordos_titulos','importacao_id'),
        ('acordos_titulos','origem_liquidacao'),('acordos_titulos','origem_encerramento'),
        ('acordos_titulos','motivo_ajuste'),
        ('parcelas','boleto'),('parcelas','status'),('parcelas','acordo_id'),
        ('parcelas','aluno_id'),('parcelas','pago_em'),
        ('acordos','numero_ulbra'),('acordos','status'),
        ('alunos','cpf'),('alunos','status_atual'),('alunos','status_jornada'),
        ('alunos','status_acionamento'),
        ('casos','quitado_em'),('casos','encerrado_operacional'),('casos','cancelado_em'),
        ('casos','nao_acionar'),('casos','situacao_operacional')
       ) as t(tabela,coluna)
  left join information_schema.columns c
         on c.table_schema='public' and c.table_name=t.tabela and c.column_name=t.coluna
 order by situacao desc, t.tabela, t.coluna;


-- =====================================================================
-- BLOCO 1 — CARREGAR A ORIGEM
--
-- ROTA A (arquivo em maos, ainda nao importado) — use esta.
--   A TEMP TABLE e local a sessao e nao toca producao.
--   Carregue pelo botao de import de CSV do SQL Editor, ou cole os
--   INSERTs. `documento` = numero do titulo exatamente como vem no
--   arquivo, SEM reformatar.
--
--   create temp table tmp_origem (
--     documento   text,
--     cpf         text,
--     valor       numeric(14,2),
--     vencimento  date,
--     curso       text
--   );
--
-- ROTA B (arquivo JA importado por bordero desde 01/10/2026) — a trilha
--   J3/I1 guardou as linhas; nao precisa do arquivo:
--
--   create temp view tmp_origem as
--     select p.documento, p.cpf_digitos as cpf, p.valor_observado as valor,
--            p.vencimento, rb.valor as curso
--       from public.titulo_presenca_importacao p
--       left join public.extracao_rotulo rb
--              on rb.id = p.tipo_boleto_id and rb.dominio = 'TIPO_BOLETO'
--      where p.escopo_id = '<<escopo_id>>';
--
--   Para listar os escopos disponiveis:
--     select id, snapshot_at, arquivo_nome, scope_key, completude, estado,
--            linhas_arquivo, linhas_capturadas, valor_total
--       from public.extracao_escopo order by snapshot_at desc;
-- =====================================================================


-- =====================================================================
-- A PARTIR DAQUI, `tmp_origem` precisa existir.
-- =====================================================================

-- ---------- BLOCO A: os quatro grupos ----------
with
origem as (
  -- dedup: mesmo documento 2x no arquivo fica 1 linha (a de maior valor),
  -- mesma regra que `registrar_presenca_extracao` ja usa.
  select distinct on (documento)
         btrim(documento)                                   as documento,
         public.extracao_documento_norm(btrim(documento))   as k,
         regexp_replace(coalesce(cpf,''),'\D','','g')       as cpf,
         valor, vencimento, curso
    from tmp_origem
   where coalesce(btrim(documento),'') <> ''
   order by documento, valor desc nulls last
),
-- lado CRM, precedencia 1: titulo (onde a MENSALIDADE vive).
-- k e unico: medido 47.949 = 47.949 em 01/10/2026.
tit as (
  select public.extracao_documento_norm(t.documento) as k,
         t.aluno_id, upper(coalesce(t.situacao,'')) as situacao,
         lower(coalesce(t.status,'')) as status, t.tipo_boleto,
         coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_original) as valor_crm,
         t.origem_liquidacao, t.origem_encerramento, t.motivo_ajuste
    from public.acordos_titulos t
   where t.documento is not null
),
-- lado CRM, precedencia 2: parcela de acordo (fallback). 13.826 = 13.826.
par as (
  select public.extracao_documento_norm(pa.boleto) as k,
         pa.aluno_id, upper(coalesce(pa.status,'')) as status, pa.acordo_id
    from public.parcelas pa
   where pa.boleto is not null
),
j as (
  select o.*,
         t.aluno_id as tit_aluno, t.situacao as tit_situacao, t.status as tit_status,
         t.valor_crm, t.origem_liquidacao, t.origem_encerramento, t.motivo_ajuste,
         pa.aluno_id as par_aluno, pa.status as par_status, pa.acordo_id,
         -- EXISTENCIA PELA CHAVE QUE CASOU, nunca por coluna anulavel:
         -- acordos_titulos.aluno_id e parcelas.acordo_id podem ser NULL num
         -- titulo que existe, e testar por elas classificaria titulo presente
         -- como ausente (defeito pego pelo teste em 08/10/2026).
         (t.k is not null)  as existe_titulo,
         (pa.k is not null) as existe_parcela
    from origem o
    left join tit t  on t.k  = o.k
    left join par pa on pa.k = o.k
),
al as (
  select j.documento,
         bool_or(
           array[ replace(upper(coalesce(a.status_atual,'')),' ','_'),
                  replace(upper(coalesce(a.status_jornada,'')),' ','_'),
                  replace(upper(coalesce(a.status_acionamento,'')),' ','_') ]
           && array['JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA',
                    'COBRANCA_CANCELADA','QUITADO','QUITADO_MANUAL']
         ) as aluno_protegido,
         bool_or(
           coalesce(c.encerrado_operacional,false)
           or c.quitado_em is not null
           or c.cancelado_em is not null
           or coalesce(c.nao_acionar,false)
           or upper(coalesce(c.situacao_operacional,'')) in ('QUITADO','QUITADO_AGUARDANDO_BAIXA')
         ) as caso_protegido
    from j
    left join public.alunos a
           on a.id = coalesce(j.tit_aluno, j.par_aluno)
           or (j.tit_aluno is null and j.par_aluno is null
               and j.cpf <> '' and regexp_replace(coalesce(a.cpf,''),'\D','','g') = j.cpf)
    left join public.casos c on c.aluno_id = a.id
   group by j.documento
),
cls as (
  select j.*,
         coalesce(al.aluno_protegido,false) as aluno_protegido,
         coalesce(al.caso_protegido,false)  as caso_protegido,
         case
           -- ---- 4. DIVERGENTE ----
           when j.documento !~ '^[0-9]{6,13}$'                     then 'D1 documento fora do formato numerico 6-13 (inclui MANUAL-*)'
           when j.existe_titulo and j.existe_parcela
                and j.tit_aluno <> j.par_aluno                     then 'D2 mesmo documento aponta para dois alunos'
           when length(j.documento) = 6                            then 'D3 boleto legado de 6 digitos (carga inicial 02-06/07)'
           when length(j.documento) = 13                           then 'D4 formato alternativo de 13 digitos'
           when not j.existe_titulo and not j.existe_parcela
                and j.cpf = ''                                     then 'D5 ausente e SEM CPF: nao da para resolver o aluno'
           -- ---- 2. PROTEGIDA ----
           when j.origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL'   then 'P1 liquidado na origem (Prime) — trava de mao unica no banco'
           when j.origem_encerramento is not null                  then 'P2 encerrado administrativo — trava no banco'
           when j.tit_situacao = 'EM_CONFIRMACAO'                  then 'P3 em Conferencia Prime — trava no banco'
           when j.tit_situacao in ('PAGO','CANCELADA','CANCELADO')  then 'P4 titulo terminal ('||j.tit_situacao||') — trava SO na tela'
           when j.tit_status = 'quitada'                           then 'P5 status quitada — trava SO na tela, e so se situacao casar'
           when j.tit_situacao = 'NEGOCIADO'                       then 'P6 NEGOCIADO — *** SEM TRAVA NENHUMA *** ver BLOCO B'
           when j.par_status in ('PAGO','PAGA','CANCELADA','CANCELADO',
                                 'ESTORNADA','ESTORNADO','RENEGOCIADA')
                                                                   then 'P7 parcela de acordo terminal ('||j.par_status||')'
           when coalesce(al.caso_protegido,false)                  then 'P8 caso quitado/encerrado/cancelado/nao_acionar'
           when coalesce(al.aluno_protegido,false)                 then 'P9 aluno em juridico/suspensao/cancelamento/quitado'
           -- ---- 1. JA EXISTENTE ----
           when j.existe_titulo or j.existe_parcela                then 'E1 ja existe e esta viva (ABERTO) — reprocesso so sobrescreve valor'
           -- ---- 3. AUSENTE ELEGIVEL ----
           else 'A1 ausente, chave confiavel, CPF presente, sem protecao'
         end as motivo
    from j left join al on al.documento = j.documento
),
fin as (
  select case left(motivo,1) when 'E' then '1 JA_EXISTENTE'
                             when 'P' then '2 PROTEGIDA'
                             when 'A' then '3 AUSENTE_ELEGIVEL'
                             when 'D' then '4 DIVERGENTE' end as grupo,
         motivo, coalesce(curso,'(sem curso)') as curso,
         valor, valor_crm,
         coalesce(tit_aluno::text, par_aluno::text, nullif(cpf,'')) as aluno_chave
    from cls
)
select 'A grupos' as bloco, grupo,
       coalesce(motivo,'— TOTAL DO GRUPO —')     as motivo,
       coalesce(curso, '— todos —')              as curso,
       count(*)                                  as parcelas,
       count(distinct aluno_chave)               as alunos,
       round(coalesce(sum(valor),0),2)           as valor_arquivo,
       round(coalesce(sum(valor_crm),0),2)       as valor_crm
  from fin
 group by grouping sets ((grupo, motivo, curso), (grupo))
 order by grupo, (motivo is not null), motivo, curso;


-- =====================================================================
-- BLOCO B — O QUE UM REPROCESSO CEGO PELA TELA DE BORDEROS FARIA
--
-- Reproduz a decisao exata de Borderos.jsx:391
--     if (linha.jaExiste && naoReabreNoBordero(linha.situacaoAtual)) continue;
-- com SITUACOES_QUE_NAO_REABREM = ['PAGO','EM_CONFIRMACAO','CANCELADA']
-- (src/utils/bordero.js). Tudo que NAO esta nessas tres e gravado com
--     situacao: 'ABERTO', saldo_corrigido: <valor do arquivo>
-- por `upsert(..., onConflict: 'documento')`.
--
-- As tres travas de banco em acordos_titulos cobrem EM_CONFIRMACAO
-- (trg_titulo_em_confirmacao_protegido), encerrado administrativo com
-- origem_encerramento (trg_titulo_encerrado_administrativo_protegido) e
-- liquidado Prime (trg_titulo_liquidado_na_origem_e_terminal).
-- NENHUMA cobre NEGOCIADO.
-- =====================================================================
with
origem as (
  select distinct on (documento) btrim(documento) as documento,
         public.extracao_documento_norm(btrim(documento)) as k, valor
    from tmp_origem where coalesce(btrim(documento),'') <> ''
   order by documento, valor desc nulls last
),
t as (
  select public.extracao_documento_norm(t.documento) as k, t.id, t.aluno_id,
         upper(coalesce(t.situacao,'')) as situacao, lower(coalesce(t.status,'')) as status,
         t.origem_liquidacao, t.origem_encerramento,
         coalesce(t.saldo_corrigido, t.valor_original) as saldo_atual
    from public.acordos_titulos t where t.documento is not null
),
j as (
  select o.documento, o.valor, t.id, t.aluno_id, t.situacao, t.status,
         t.origem_liquidacao, t.origem_encerramento, t.saldo_atual,
         -- a tela pula?
         (t.id is not null and t.situacao in ('PAGO','EM_CONFIRMACAO','CANCELADA')) as tela_pula,
         -- o banco coage de volta?
         (t.origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL'
          or t.origem_encerramento is not null
          or t.situacao = 'EM_CONFIRMACAO')                                        as banco_coage
    from origem o join t on t.k = o.k
)
select 'B dano' as bloco, efeito, situacao_antes,
       count(*) as titulos, count(distinct aluno_id) as alunos,
       round(coalesce(sum(saldo_atual),0),2)   as saldo_hoje,
       round(coalesce(sum(saldo_depois),0),2)  as saldo_depois,
       round(coalesce(sum(saldo_depois),0) - coalesce(sum(saldo_atual),0),2) as delta
  from (
    select j.*,
           -- pulado pela tela ou revertido pelo banco => saldo nao muda.
           -- So o que a tela grava E o banco aceita assume o valor do arquivo.
           case when tela_pula or banco_coage then saldo_atual else valor end as saldo_depois,
           case
             when tela_pula   then 'a) pulado pela tela — nada muda'
             when banco_coage then 'b) tela grava, BANCO reverte — nada muda'
             when situacao = 'ABERTO'
                              then 'c) ja ABERTO — so o valor e sobrescrito'
             when situacao = 'NEGOCIADO'
                              then 'd) *** NEGOCIADO -> ABERTO: REATIVADO ***'
             else                   'e) '||situacao||' -> ABERTO: REATIVADO'
           end as efeito,
           situacao as situacao_antes
      from j
  ) x
 group by efeito, situacao_antes
 order by efeito desc, situacao_antes;


-- ---------- BLOCO B2: alunos que o reprocesso tiraria de "quitado" ----------
-- Borderos.jsx:445-530 faz, para todo aluno com titulo gravado no lote e
-- status_jornada em (QUITADO, QUITADO_MANUAL):
--   1. status_jornada/status_atual/status_acionamento/proxima_acao := CONTATAR
--   2. titulos 'quitada' com motivo_ajuste ilike '%quitado manualmente%'
--      voltam a ABERTO/em_aberto com saldo restaurado
--   3. parcelas PAGO com pago_em NULL voltam a A_VENCER, e o acordo QUITADO
--      e reativado se sobrar saldo
-- Isto NAO e opcional nem configuravel: roda sempre.
with
origem as (
  select distinct public.extracao_documento_norm(btrim(documento)) as k
    from tmp_origem where coalesce(btrim(documento),'') <> ''
),
alvo as (
  select distinct t.aluno_id
    from public.acordos_titulos t
    join origem o on o.k = public.extracao_documento_norm(t.documento)
   where t.aluno_id is not null
     and upper(coalesce(t.situacao,'')) not in ('PAGO','EM_CONFIRMACAO','CANCELADA')
)
select 'B2 reativacao' as bloco,
       'alunos hoje QUITADO/QUITADO_MANUAL que voltariam para CONTATAR' as efeito,
       count(*) as alunos
  from alvo join public.alunos a on a.id = alvo.aluno_id
 where upper(coalesce(a.status_jornada,'')) in ('QUITADO','QUITADO_MANUAL')
union all
select 'B2 reativacao',
       'titulos "quitado manualmente" que teriam o saldo restaurado',
       count(*)
  from public.acordos_titulos t
 where t.aluno_id in (
         select a.id from alvo join public.alunos a on a.id = alvo.aluno_id
          where upper(coalesce(a.status_jornada,'')) in ('QUITADO','QUITADO_MANUAL'))
   and lower(coalesce(t.status,'')) = 'quitada'
   and t.motivo_ajuste ilike '%quitado manualmente%'
union all
select 'B2 reativacao',
       'parcelas PAGO sem data que voltariam para A_VENCER',
       count(*)
  from public.parcelas p
  join public.acordos ac on ac.id = p.acordo_id
 where upper(coalesce(ac.status,'')) = 'QUITADO'
   and ac.aluno_id in (
         select a.id from alvo join public.alunos a on a.id = alvo.aluno_id
          where upper(coalesce(a.status_jornada,'')) in ('QUITADO','QUITADO_MANUAL'))
   and upper(coalesce(p.status,'')) = 'PAGO' and p.pago_em is null;


-- ---------- BLOCO C: censo de confiabilidade da chave ----------
select 'C chave' as bloco,
       length(btrim(documento))                      as digitos,
       (btrim(documento) ~ '^[0-9]+$')               as so_digitos,
       count(*)                                      as linhas,
       count(distinct public.extracao_documento_norm(btrim(documento))) as chaves_normalizadas,
       round(coalesce(sum(valor),0),2)               as valor
  from tmp_origem
 where coalesce(btrim(documento),'') <> ''
 group by 1,2,3
 order by digitos nulls first;


-- ---------- BLOCO D: travas — TODAS tem de voltar 0 ----------
select 'D trava' as bloco, 'documento vazio no arquivo' as trava,
       (select count(*) from tmp_origem where coalesce(btrim(documento),'') = '') as devolveu
union all
select 'D trava','documento duplicado no arquivo',
       (select count(*) - count(distinct btrim(documento)) from tmp_origem
         where coalesce(btrim(documento),'') <> '')
union all
select 'D trava','normalizacao funde documentos distintos do arquivo',
       (select count(distinct btrim(documento))
             - count(distinct public.extracao_documento_norm(btrim(documento)))
          from tmp_origem where coalesce(btrim(documento),'') <> '')
union all
select 'D trava','linha de ACORDO no arquivo (deveria ser so mensalidade)',
       (select count(*) from tmp_origem where btrim(documento) ~ '^0?5\d{10}$')
union all
select 'D trava','normalizacao colide dentro de acordos_titulos',
       (select count(*) - count(distinct public.extracao_documento_norm(documento))
          from public.acordos_titulos where documento is not null)
union all
select 'D trava','normalizacao colide dentro de parcelas',
       (select count(*) - count(distinct public.extracao_documento_norm(boleto))
          from public.parcelas where boleto is not null)
union all
select 'D trava','chave em acordos_titulos E parcelas com ALUNO diferente',
       (select count(*) from
          (select public.extracao_documento_norm(t.documento) k, t.aluno_id
             from public.acordos_titulos t where t.documento is not null) a
          join (select public.extracao_documento_norm(pa.boleto) k, pa.aluno_id
                  from public.parcelas pa where pa.boleto is not null) b
            on b.k = a.k and b.aluno_id <> a.aluno_id)
union all
select 'D trava','acordo com numero_ulbra acima de 5 digitos (quebra substr(,4,5))',
       (select count(*) from public.acordos
         where numero_ulbra is not null and length(btrim(numero_ulbra::text)) > 5);


-- ---------- BLOCO E: foto antes/depois (rodar IDENTICO antes e depois) ----------
-- Digest md5, nao so total: dois movimentos que se compensam mantem o
-- total e mudam o digest.
select 'E foto' as bloco, 'acordos_titulos: linhas' as ponto, count(*)::text as valor
  from public.acordos_titulos
union all select 'E foto','acordos_titulos por situacao',
  (select string_agg(s||'='||q, ' | ' order by s) from
    (select upper(coalesce(situacao,'(null)')) s, count(*) q
       from public.acordos_titulos group by 1) z)
union all select 'E foto','acordos_titulos: digest (documento,situacao,status,saldo)',
  md5(string_agg(documento||'>'||coalesce(situacao,'')||'>'||coalesce(status,'')
                 ||'>'||coalesce(saldo_corrigido,0)::text, '|' order by documento))
  from public.acordos_titulos
union all select 'E foto','parcelas: digest (id,status,pago_em)',
  md5(string_agg(id::text||'>'||coalesce(status,'')||'>'||coalesce(pago_em::text,''), '|' order by id))
  from public.parcelas
union all select 'E foto','acordos: digest (id,status,saldo)',
  md5(string_agg(id::text||'>'||coalesce(status,'')||'>'||coalesce(saldo,0)::text, '|' order by id))
  from public.acordos
union all select 'E foto','alunos: digest (id,status_jornada)',
  md5(string_agg(id::text||'>'||coalesce(status_jornada,''), '|' order by id))
  from public.alunos
union all select 'E foto','alunos: soma saldo_total',
  to_char(coalesce(sum(saldo_total),0),'FM999G999G990D00') from public.alunos
union all select 'E foto','casos: soma saldo_total',
  to_char(coalesce(sum(saldo_total),0),'FM999G999G990D00') from public.casos
union all select 'E foto','casos nao encerrados',
  count(*) filter (where not coalesce(encerrado_operacional,false))::text from public.casos;

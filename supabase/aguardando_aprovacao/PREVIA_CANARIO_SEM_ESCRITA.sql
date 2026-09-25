-- =====================================================================
-- PRÉVIA DO CANÁRIO — 100% SELECT, NENHUMA ESCRITA
--
-- Saída em cinco blocos, nesta ordem:
--   A) LINHAS DO ARQUIVO ................ total recebido
--   B) BLOQUEADAS ANTES DO INSERT ....... com o motivo de cada bloqueio
--   C) CHEGAM AO INSERT ................. o universo do canário
--   D) CASCATA, SOMENTE SOBRE C ......... a soma tem de ser igual a |C|
--   E) DIAGNÓSTICO DO ARQUIVO BRUTO ..... não participa do canário
--
-- A regra que organiza tudo: a cascata de vínculo só acontece para a linha que
-- é INSERIDA. Linha bloqueada antes do INSERT não dispara gatilho, não vincula
-- ninguém e não entra na fila. Classificá-la junto com as demais produz duas
-- leituras inconsistentes do mesmo lote.
--
-- ---------------------------------------------------------------------------
-- COMO PREENCHER o bloco `linhas`: o arquivo do Santander tem 11 colunas
-- posicionais (ver normalizarLinhaSantander em src/pages/ProjecaoHoraHora.jsx):
--
--   A instituição ............ descartada
--   B "matricula - Nome" ..... matricula  +  aluno_nome
--   C título ................. titulo_numero
--   D operador ............... operador (vira e-mail no import)
--   E convênio+título ........ numero_parcela_completo   <-- O BOLETO, 11 dígitos
--   F convênio ............... descartada
--   G vencimento ............. vencimento
--   H valor original ......... valor_original
--   I honorário .............. valor_honorario
--   J data ................... data_pagamento
--   K valor pago ............. valor_pago
--
-- O arquivo NÃO traz CPF. Por isso a etapa 1 da cascata quase nunca vence.
--
-- ---------------------------------------------------------------------------
-- AS TRÊS PORTAS QUE UMA LINHA TEM DE PASSAR, na ordem do importador
-- (projecao_importar_pagamentos, assinatura de 7 parâmetros):
--
--   1. DISTINCT ON (numero_parcela_completo, valor_pago)
--        ORDER BY numero_parcela_completo, valor_pago, data_pagamento, ord DESC
--      Duas linhas do MESMO arquivo com mesmo boleto e mesmo valor colapsam em
--      uma. Sobrevive a de `data_pagamento` MENOR; em empate de data, a de `ord`
--      MAIOR, isto é, a ÚLTIMA ocorrência no arquivo. `ord` vem de
--      `WITH ORDINALITY` sobre as linhas do arquivo, é único, e por isso o
--      desempate É DETERMINÍSTICO mesmo com boleto, valor e data iguais.
--
--      ASSIMETRIA DO IMPORTADOR, reproduzida aqui de propósito: esta porta
--      compara `valor_pago` CRU (igualdade do DISTINCT ON), enquanto a porta 2
--      compara `round(valor_pago, 2)`. São regras diferentes no mesmo código.
--
--   2. NOT EXISTS contra o que já está no banco -- mesmo boleto + mesmo valor,
--      QUALQUER data. É o guard real, e é mais forte que o índice único.
--      Depende de dois parâmetros do import: `p_retroativo` (aqui assumido
--      false, o caso normal) e `p_substituir_importacao_id` (aqui assumido
--      nulo; numa substituição o guard ignora as linhas da importação
--      substituída e o comportamento muda).
--
--   3. ON CONFLICT (numero_parcela_completo, valor_pago, data_pagamento)
--      WHERE numero_parcela_completo IS NOT NULL -- DO UPDATE SET (...)
--      O índice único. Quem passou pela porta 2 normalmente não colide aqui.
--
-- ---------------------------------------------------------------------------
-- O QUE ACONTECE DE VERDADE NO CAMINHO DO `ON CONFLICT DO UPDATE`
-- (verificado em 12/09/2026; uma versão anterior deste arquivo afirmava o
--  contrário e estava ERRADA)
--
-- No PostgreSQL, `BEFORE INSERT ... FOR EACH ROW` executa ANTES da detecção do
-- conflito. Portanto, numa linha que acaba virando UPDATE:
--
--   * `trg_pagamento_vincula_identificador` (BEFORE INSERT, FOR EACH ROW)
--     **RODA**. Ele faz todas as buscas -- CPF, boleto exato, varredura de prefixo,
--     numero_ulbra -- e grava em NEW: aluno_id, origem_vinculo, origem_vinculo_ref,
--     origem_vinculo_em. Esses valores ficam disponíveis como EXCLUDED.
--
--   * O `DO UPDATE SET` grava SOMENTE estas 10 colunas:
--       valor_honorario, tipo_pagamento, aluno_nome, cpf, titulo_numero, dados,
--       importacao_id, retroativo, operador_email (condicional a
--       operador_ajustado_manualmente), operador_nome (mesma condição).
--     NÃO estão na lista: aluno_id, origem_vinculo, origem_vinculo_ref,
--     origem_vinculo_em, matricula, valor_pago, data_pagamento,
--     numero_parcela_completo.
--     CONSEQUÊNCIA: o trabalho do BEFORE INSERT é CALCULADO e DESCARTADO. A linha
--     que já existia mantém o aluno_id antigo e segue com origem_vinculo NULL.
--     Reimportar arquivo NÃO migra pagamento histórico para a regra nova.
--
--   * Dois outros BEFORE são `INSERT OR UPDATE OF <coluna>` e, como essas colunas
--     estão no SET, eles TAMBÉM rodam no caminho do UPDATE:
--       - trg_pagamento_matricula (UPDATE OF dados): preenche matricula se
--         estiver nula. Então matricula PODE mudar no UPDATE, pelo gatilho, e não
--         pela lista do SET.
--       - trg_pagamento_nome_do_operador (UPDATE OF operador_email, operador_nome).
--
--   * `trg_pagamento_enfileira_sem_vinculo` é AFTER INSERT FOR EACH ROW: dispara
--     SOMENTE para linha efetivamente INSERIDA. Na linha que virou UPDATE ele NÃO
--     roda -- não há linha na fila, mesmo que o BEFORE INSERT tenha concluído
--     SEM_VINCULO. Valem o mesmo para trg_pagamento_baixa_documento e
--     pagamentos_detectar_suspeita_dup (os dois AFTER INSERT FOR EACH ROW).
--     Quem roda nos dois caminhos é trg_audit (AFTER INSERT OR DELETE OR UPDATE).
--
-- Não é hipótese: 5.609 pagamentos têm importacao_id de uma importação criada
-- DEPOIS do próprio pagamento, e 202 importações estão com status SUBSTITUIDA --
-- o caminho do DO UPDATE é o caminho histórico dominante de reimportação.
--
-- ---------------------------------------------------------------------------
-- QUAL ARQUIVO USAR, E O QUE NÃO SERVE DE PROVA
--
-- O canário é um parcial do Santander exportado NO PRÓPRIO DIA pela gestão.
-- Nenhum nome de arquivo fica reservado ou presumido de antemão.
--
-- ATENÇÃO a um erro de raciocínio que já foi cometido aqui: "0 pagamentos com
-- data_pagamento = <data>" NÃO prova que o arquivo daquele dia não existe. Prova
-- apenas que nenhum pagamento daquela data foi inserido no CRM. A existência ou
-- ausência do arquivo é fato do sistema de arquivos e do Santander, não do banco.
--
-- ORDEM OBRIGATÓRIA no dia do canário:
--   1. exportar o parcial do Santander
--   2. rodar ESTE arquivo  (nenhuma escrita)
--   3. entregar: A, B, C, D, todas as linhas SEM_VINCULO de C, baseline dos
--      alunos de C
--   4. esperar autorização explícita da gestão
--   5. só então o INSERT
--
-- ENSAIOS de 12/09/2026:
--   * 26 linhas de `11.09.xlsx` (as que entraram): 26 recebidas, 26 bloqueadas
--     antes do INSERT (todas JA_EXISTE_EXATO), 0 chegam ao INSERT, cascata
--     efetiva = 0. O bloco E registrou, separadamente, que sem o guard seriam
--     16 NUMERO_ULBRA_UNICO e 10 SEM_VINCULO.
--   * Porta DISTINCT ON, em fixture de VALUES (nenhuma tabela tocada): 5 linhas
--     -> 3 sobreviventes, 2 DUPLICADA_NO_ARQUIVO. A expressão original do
--     importador e a reprodução desta prévia escolheram as MESMAS linhas.
--     O arquivo bruto de 35 linhas do `11.09.xlsx` não está acessível; o que se
--     prova aqui é a regra, não aquele arquivo.
-- =====================================================================

-- `ord` = a POSIÇÃO DA LINHA NO ARQUIVO, 1..N, na ordem em que aparece. Não é
-- enfeite: é o desempate do DISTINCT ON. Preencher na mão, em ordem.
with linhas(ord, numero_parcela_completo, valor_pago, data_pagamento, aluno_nome, cpf, matricula, titulo_numero) as (values
  -- (1, '50716220001', 536.13, date '2026-09-14', 'NOME COMO VEIO NO ARQUIVO', null, '2026002032', '4295892'),
  -- (2, ...),  -- uma linha por registro do arquivo, ord crescente
  (null::int, null::text, null::numeric, null::date, null::text, null::text, null::text, null::text)
)
, recebidas as (select * from linhas where numero_parcela_completo is not null)

-- PORTA 1: duplicata dentro do próprio arquivo.
-- Partição por valor CRU (não arredondado) e a mesma ordenação do importador:
-- data_pagamento ASC (NULLS LAST, como no ORDER BY dele), depois ord DESC.
-- Conferido contra a expressão original `DISTINCT ON ... ORDER BY` em fixture:
-- as duas escolhem exatamente as mesmas linhas.
, colapso as (
  select r.*,
    row_number() over (partition by r.numero_parcela_completo, r.valor_pago
                       order by r.data_pagamento, r.ord desc) posicao_no_grupo,
    count(*) over (partition by r.numero_parcela_completo, r.valor_pago) no_grupo
  from recebidas r)

-- PORTAS 2 e 3: contra o que já existe no banco
, portas as (
  select c.*,
    exists (select 1 from public.pagamentos p
             where p.numero_parcela_completo = c.numero_parcela_completo
               and round(coalesce(p.valor_pago,0),2) = round(c.valor_pago,2)
               and p.data_pagamento = c.data_pagamento) ja_existe_exato,
    exists (select 1 from public.pagamentos p
             where p.numero_parcela_completo = c.numero_parcela_completo
               and round(coalesce(p.valor_pago,0),2) = round(c.valor_pago,2)
               and coalesce(p.retroativo,false) = false
               and not (coalesce(p.dados,'{}'::jsonb) ? 'estornado_em')) guard_boleto_valor
  from colapso c)

, avaliadas as (
  select p.*,
    case
      when p.posicao_no_grupo > 1 then 'DUPLICADA_NO_ARQUIVO'
      when p.ja_existe_exato      then 'JA_EXISTE_EXATO'
      when p.guard_boleto_valor   then 'GUARD_BOLETO_VALOR'
      else null
    end bloqueio
  from portas p)

-- C) O UNIVERSO DO CANÁRIO
, chegam as (select * from avaliadas where bloqueio is null)

-- cascata, calculada uma vez e reaproveitada por D (sobre C) e E (sobre as bloqueadas)
, passo as (
  select a.*, nullif(regexp_replace(coalesce(a.cpf,''),'\D','','g'),'') cpfd,
         case when length(a.numero_parcela_completo)=11 then substring(a.numero_parcela_completo,2,6) end pref
    from avaliadas a)
, resolvido as (
  select p.*,
    (select al.id from public.alunos al
      where length(p.cpfd) between 10 and 11
        and lpad(regexp_replace(coalesce(al.cpf,''),'\D','','g'),11,'0') = lpad(p.cpfd,11,'0') limit 1) id_cpf,
    (select ac.aluno_id from public.parcelas pa join public.acordos ac on ac.id = pa.acordo_id
      where pa.boleto = p.numero_parcela_completo limit 1) id_boleto,
    (select count(distinct pa.acordo_id) from public.parcelas pa
      where p.pref is not null and pa.boleto like '5'||p.pref||'%') pref_acordos,
    (select count(distinct ac.aluno_id) from public.parcelas pa join public.acordos ac on ac.id = pa.acordo_id
      where p.pref is not null and pa.boleto like '5'||p.pref||'%') pref_alunos,
    (select min(ac.aluno_id::text)::uuid from public.parcelas pa join public.acordos ac on ac.id = pa.acordo_id
      where p.pref is not null and pa.boleto like '5'||p.pref||'%') pref_aluno,
    (select count(*) from public.acordos ac
      where p.pref is not null and ac.numero_ulbra is not null and lpad(ac.numero_ulbra,6,'0') = p.pref) ulb_acordos,
    (select count(distinct ac.aluno_id) from public.acordos ac
      where p.pref is not null and ac.numero_ulbra is not null and lpad(ac.numero_ulbra,6,'0') = p.pref) ulb_alunos,
    (select min(ac.aluno_id::text)::uuid from public.acordos ac
      where p.pref is not null and ac.numero_ulbra is not null and lpad(ac.numero_ulbra,6,'0') = p.pref) ulb_aluno
  from passo p)
, classificado as (
  select r.*,
    case when id_cpf is not null                   then 'CPF'
         when id_boleto is not null                  then 'BOLETO_EXATO'
         when length(numero_parcela_completo) <> 11  then 'SEM_VINCULO'
         when pref_acordos = 1                       then 'PREFIXO_UNICO'
         when ulb_acordos = 1                        then 'NUMERO_ULBRA_UNICO'
         else 'SEM_VINCULO' end etapa,
    case when id_cpf is not null then id_cpf
         when id_boleto is not null then id_boleto
         when pref_acordos = 1 then pref_aluno
         when ulb_acordos = 1 then ulb_aluno end aluno_previsto,
    case when length(numero_parcela_completo) <> 11 then 'boleto fora do padrao de 11 digitos'
         when pref_acordos > 1 then 'prefixo do boleto aponta para mais de um acordo: ambiguo por desenho'
         when coalesce(pref_acordos,0)=0 and coalesce(ulb_acordos,0)=0
           then 'boleto nao existe em parcelas e o acordo nao esta no CRM'
         when ulb_acordos > 1 then 'numero_ulbra aponta para mais de um acordo' end motivo_financeiro
  from resolvido r)
, cascata_c as (select * from classificado where bloqueio is null)

-- =====================================================================
select 'A. LINHAS DO ARQUIVO' bloco, 'total recebido' chave,
       count(*)::text qtd, to_char(sum(valor_pago),'FM999G990D00') valor, '' detalhe
  from recebidas

union all select 'B. BLOQUEADAS ANTES DO INSERT', 'total bloqueado',
  count(*) filter (where bloqueio is not null)::text,
  to_char(coalesce(sum(valor_pago) filter (where bloqueio is not null),0),'FM999G990D00'),
  'nao disparam gatilho, nao vinculam, nao entram na fila' from avaliadas
union all select 'B. BLOQUEADAS ANTES DO INSERT', '  motivo: DUPLICADA_NO_ARQUIVO',
  count(*) filter (where bloqueio='DUPLICADA_NO_ARQUIVO')::text, '',
  'mesmo boleto e mesmo valor de outra linha DO ARQUIVO; sobrevive a de data menor, e em empate a de ord maior' from avaliadas
union all select 'B1. DUPLICADA NO ARQUIVO, linha a linha', 'ord '||ord::text,
  numero_parcela_completo, to_char(valor_pago,'FM999G990D00'),
  'data '||coalesce(data_pagamento::text,'?')||' | grupo de '||no_grupo::text||' linhas | posicao '||posicao_no_grupo::text
  ||' -> DESCARTADA pelo DISTINCT ON' from avaliadas where bloqueio = 'DUPLICADA_NO_ARQUIVO'
union all select 'B. BLOQUEADAS ANTES DO INSERT', '  motivo: JA_EXISTE_EXATO',
  count(*) filter (where bloqueio='JA_EXISTE_EXATO')::text, '',
  'boleto + valor + data ja no banco' from avaliadas
union all select 'B. BLOQUEADAS ANTES DO INSERT', '  motivo: GUARD_BOLETO_VALOR',
  count(*) filter (where bloqueio='GUARD_BOLETO_VALOR')::text, '',
  'boleto + valor ja no banco em OUTRA data -- o guard real do importador' from avaliadas

union all select 'C. CHEGAM AO INSERT', 'universo do canario',
  count(*)::text, to_char(coalesce(sum(valor_pago),0),'FM999G990D00'),
  'so estas serao inseridas e so estas disparam a cascata' from chegam

union all select 'D. CASCATA (somente sobre C)', etapa,
  count(*)::text, to_char(sum(valor_pago),'FM999G990D00'), '' from cascata_c group by etapa
union all select 'D. CASCATA (somente sobre C)', 'zz TOTAL -- deve bater com C',
  count(*)::text, to_char(coalesce(sum(valor_pago),0),'FM999G990D00'),
  'se nao bater com C, a previa esta errada' from cascata_c

union all select 'C1. LINHA QUE CHEGA AO INSERT', etapa,
  coalesce(numero_parcela_completo,'(sem boleto)'), to_char(valor_pago,'FM999G990D00'),
  coalesce(data_pagamento::text,'?')||' | aluno previsto: '||coalesce(aluno_previsto::text,'NENHUM')
  ||' | prefixo '||coalesce(pref,'-')||': '||coalesce(pref_acordos,0)::text||' acordo/'||coalesce(pref_alunos,0)::text
  ||' aluno via parcela, '||coalesce(ulb_acordos,0)::text||' acordo/'||coalesce(ulb_alunos,0)::text||' aluno via numero_ulbra'
  from cascata_c

union all select 'C2. SEM_VINCULO (ira para a fila)', coalesce(aluno_nome,'(sem nome no arquivo)'),
  coalesce(numero_parcela_completo,'(sem boleto)'), to_char(valor_pago,'FM999G990D00'),
  coalesce(data_pagamento::text,'?')||' | MOTIVO: '||coalesce(motivo_financeiro,'-')
  ||' | SUGESTOES (apenas sugestao, NAO vinculam e NAO preenchem aluno_id): '||
  coalesce((select string_agg(al.nome||' [cpf '||coalesce(al.cpf_mascarado,'-')||', matricula '||coalesce(al.matricula,'-')||']', ' ; ')
              from public.alunos al
             where coalesce(trim(c.aluno_nome),'') <> ''
               and translate(upper(regexp_replace(trim(al.nome),'\s+',' ','g')),
                             'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
                 = translate(upper(regexp_replace(trim(c.aluno_nome),'\s+',' ','g')),
                             'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')),
           'nenhum nome parecido na base')
  from cascata_c c where etapa = 'SEM_VINCULO'

union all select 'C3. BASELINE DOS ALUNOS DE C', 'alunos previstos',
  (select count(distinct aluno_previsto)::text from cascata_c where aluno_previsto is not null),
  to_char(coalesce((select sum(al.saldo_total) from public.alunos al
                     where al.id in (select aluno_previsto from cascata_c where aluno_previsto is not null)),0),
          'FM999G999G990D00'), 'saldo_total somado ANTES da importacao'
union all select 'C3. BASELINE DOS ALUNOS DE C', 'parcelas desses alunos (total / PAGO)',
  (select count(*)::text from public.parcelas pa join public.acordos ac on ac.id=pa.acordo_id
    where ac.aluno_id in (select aluno_previsto from cascata_c where aluno_previsto is not null)),
  (select count(*) filter (where upper(coalesce(pa.status,''))='PAGO')::text
     from public.parcelas pa join public.acordos ac on ac.id=pa.acordo_id
    where ac.aluno_id in (select aluno_previsto from cascata_c where aluno_previsto is not null)), ''
union all select 'C3. BASELINE DOS ALUNOS DE C', 'casos desses alunos (total / nao encerrados)',
  (select count(*)::text from public.casos c
    where c.aluno_id in (select aluno_previsto from cascata_c where aluno_previsto is not null)),
  (select count(*) filter (where not coalesce(c.encerrado_operacional,false))::text from public.casos c
    where c.aluno_id in (select aluno_previsto from cascata_c where aluno_previsto is not null)), ''

-- ---------------------------------------------------------------------
-- E) diagnóstico do arquivo bruto. NÃO participa do canário.
-- ---------------------------------------------------------------------
union all select 'E. NAO PARTICIPA DO CANARIO / NAO CHEGA AO INSERT', etapa,
  count(*)::text, to_char(sum(valor_pago),'FM999G990D00'),
  'classificacao hipotetica das linhas BLOQUEADAS, so para analise do arquivo'
  from classificado where bloqueio is not null group by etapa
union all select 'E. NAO PARTICIPA DO CANARIO / NAO CHEGA AO INSERT', 'zz TOTAL bloqueado',
  count(*)::text, to_char(coalesce(sum(valor_pago),0),'FM999G990D00'),
  'deve bater com o total de B' from classificado where bloqueio is not null
order by 1, 2;

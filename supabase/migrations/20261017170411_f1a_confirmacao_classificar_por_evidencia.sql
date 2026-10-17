-- F1.a -- CLASSIFICAR A FILA DE CONFIRMACAO POR EVIDENCIA. SO LEITURA.
--
-- AUTORIZADA PELA GESTAO em 17/10/2026 (Amanda), depois da medicao em
-- docs/F1A-CLASSIFICACAO-CONFIRMACAO-2026-10-17.md.
-- Esta migration cria UMA funcao STABLE que nao escreve em lugar nenhum: nenhum
-- INSERT, UPDATE ou DELETE, nenhuma coluna nova, nenhum gatilho tocado. Nao
-- altera financeiro, saldo, titulo, acordo, parcela, caso nem situacao academica.
--
-- FONTE DE VERDADE CONSULTADA ANTES (obrigatorio por CLAUDE.md):
-- docs/integracoes/README.md -> prime-mapa-fontes-verdade.md.
-- O que ela determina e que governa este arquivo:
--
--   * "Caixa efetivamente recebido: **Santander**, NUNCA `paidAmount` da Prime";
--   * "Situacao do titulo (pago / em aberto / cancelado) e saldo em aberto:
--     **NAO EXPOSTA**" pela API Prime;
--   * `financialStatement[].paymentDate` vem preenchido inclusive em titulo que
--     o CRM mantem ABERTO -- "nao inferir: presenca de `paymentDate` = pagamento".
--
-- Por isso NENHUMA classe desta funcao le a Prime. A prova de caixa vem de
-- `public.pagamentos` (arquivo Santander, via importacao PROJECAO_DIARIA) e do
-- veredito do proprio motor do CRM. Mesma doutrina que a migration
-- 20261009181925 (`confirmacao_exige_pagamento_comprovado`, EM PROD desde
-- 09/10/2026) ja aplica na rota Prime: **importar arquivo nao comprova pagamento**.
--
-- ====================================================================
-- AS QUATRO CLASSES, COM PRECEDENCIA FIXA
-- ====================================================================
-- O universo e uma solicitacao da fila unica
-- (`solicitacoes_confirmacao_pagamento`). As linhas do arquivo que a originaram
-- sao as de `pagamentos` com o mesmo (aluno_id, data_pagamento) -- a mesma chave
-- que `trg_pagamentos_gerar_confirmacao` usa para agregar. A ordem abaixo e
-- avaliada de cima para baixo e a primeira que casa decide:
--
-- 4a DESCONHECIDA / SEM_LINHA_NO_ARQUIVO -- nao ha linha de arquivo para
--    (aluno, data). A solicitacao nasceu por outra rota (comprovante do
--    operador, lancamento da gestao) ou o pagamento foi removido/substituido.
--    Nada a afirmar.
--
-- 3a DIVERGENCIA / MOTOR_CONTRADIZ -- alguma linha tem `status_conciliacao` em
--    (PARCELA_JA_PAGA, REVISAO, TITULO_ORIGINAL_LIQUIDADO): o motor achou o
--    titulo e ele contradiz o pagamento. Excecao para humano.
--
-- 3b DIVERGENCIA / BAIXA_PARCIAL -- parte das linhas baixou e parte nao. O
--    conjunto nao fecha; confirmar o todo seria afirmar o que so vale para parte.
--
-- 2  BAIXA_CONFIRMADA -- TODAS as linhas estao `BAIXADO` E todas tem vinculo
--    por identificador (`BOLETO_EXATO`, `NUMERO_ULBRA_UNICO`, `PREFIXO_UNICO`)
--    ou decisao registrada da gestao (`GESTAO_MANUAL`). Nunca por proximidade
--    de valor ou de data.
--
-- 4b DESCONHECIDA / MOTOR_NAO_ACHOU_PARCELA -- nenhuma linha tem veredito, e
--    existe `baixa_automatica_log` com `SEM_PARCELA`: o motor rodou e nao achou
--    onde aplicar. Diferente de nunca ter rodado, e a acao e outra.
--
-- 4c DESCONHECIDA / MOTOR_NUNCA_RODOU -- nenhuma linha tem veredito e nao ha
--    log. E o passivo de jul/ago, importado antes de
--    `trg_pagamento_vincula_identificador` existir.
--
-- 1  PAGAMENTO_INFORMADO -- o arquivo diz que entrou dinheiro, o motor olhou e
--    nao provou titulo (AGUARDANDO_ACORDO, AGUARDANDO_AMARRACAO, SEM_VINCULO).
--    Pagamento informado, nao comprovado. E a classe de saida, nao a de erro.
--
-- ====================================================================
-- O QUE ESTA FUNCAO NAO FAZ, DE PROPOSITO
-- ====================================================================
-- * nao grava a classe em coluna nenhuma -- quem quiser persistir e F1.b;
-- * nao confirma, nao rejeita, nao quita, nao baixa, nao vincula;
-- * nao tira ninguem da cobranca nem devolve ninguem para a cobranca
--   (`alunos_em_confirmacao_pendente()` continua lendo `status`, que nao muda);
-- * nao aplica rateio. O rateio medido em 09/10 (um pagamento de base
--   R$ 950,16 aparecia como prova de quatro titulos somando R$ 2.388,27) vale
--   para quem usa `pagamentos` como prova DE UM TITULO. Aqui a classe 2 usa o
--   veredito que o motor ja carimbou na linha, nao um casamento novo. O rateio
--   volta a ser obrigatorio em F1.c, quando `titulo_id` passar a ser gravado.
--
-- GRANT: padrao do projeto para RPC de gestao -- `revoke from public, anon`
-- (funcao nova nasce com EXECUTE para PUBLIC, e PUBLIC inclui anon),
-- `grant execute to authenticated` (todo logado chama a API como authenticated,
-- inclusive a gestao) e portao DENTRO da funcao.

create or replace function public.confirmacao_classificar_por_evidencia(
  p_incluir_encerradas boolean default false
)
returns table (
  solicitacao_id     uuid,
  status             text,
  aluno_id           text,
  aluno_nome         text,
  data_pagamento     date,
  valor_informado    numeric,
  origem_divida      text,
  classe             text,
  motivo             text,
  n_linhas_arquivo   integer,
  soma_arquivo       numeric,
  valor_bate         boolean,
  n_baixado          integer,
  n_contradiz        integer,
  n_sem_veredito     integer,
  n_identificador    integer,
  n_gestao_manual    integer,
  log_baixada        integer,
  log_sem_parcela    integer,
  log_erro           integer,
  pagamento_ids      uuid[],
  titulos_do_arquivo text[]
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  -- Portao interno: a fila de confirmacao e dado financeiro por aluno.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Classificacao da fila de confirmacao: apenas gestao financeira.'
      using errcode = '42501';
  end if;

  return query
  with base as (
    select s.id, s.status, s.aluno_id, s.aluno_nome, s.data_pagamento,
           coalesce(s.valor_informado, 0) valor_informado, s.origem_divida
      from public.solicitacoes_confirmacao_pagamento s
     where s.status = 'AGUARDANDO_CONFIRMACAO'
        or (p_incluir_encerradas and s.data_pagamento is not null)
  ),
  linhas as (
    select b.id sol_id, p.id pagamento_id, coalesce(p.valor_pago, 0) valor_pago,
           p.origem_vinculo, p.status_conciliacao, p.titulo_numero
      from base b
      join public.pagamentos p
        on p.aluno_id::text = b.aluno_id
       and p.data_pagamento = b.data_pagamento
  ),
  -- Corroboracao independente do carimbo da linha: o motor de baixa deixou
  -- rastro proprio em baixa_automatica_log, com a parcela que atingiu.
  corrob as (
    select l.sol_id, l.pagamento_id,
           count(bl.id) filter (where bl.resultado = 'BAIXADA')     log_baixada,
           count(bl.id) filter (where bl.resultado = 'SEM_PARCELA') log_sem_parcela,
           count(bl.id) filter (where bl.resultado = 'ERRO')        log_erro
      from linhas l
      left join public.baixa_automatica_log bl on bl.pagamento_id = l.pagamento_id
     group by 1, 2
  ),
  agg as (
    select b.id, b.status, b.aluno_id, b.aluno_nome, b.data_pagamento,
           b.valor_informado, b.origem_divida,
           count(l.pagamento_id)::integer n_linhas,
           round(coalesce(sum(l.valor_pago), 0), 2) soma_arquivo,
           (count(*) filter (where l.status_conciliacao = 'BAIXADO'))::integer n_baixado,
           (count(*) filter (where l.status_conciliacao
              in ('PARCELA_JA_PAGA', 'REVISAO', 'TITULO_ORIGINAL_LIQUIDADO')))::integer n_contradiz,
           (count(*) filter (where l.origem_vinculo is null
                               and l.status_conciliacao is null))::integer n_sem_veredito,
           (count(*) filter (where l.origem_vinculo
              in ('BOLETO_EXATO', 'NUMERO_ULBRA_UNICO', 'PREFIXO_UNICO')))::integer n_identificador,
           (count(*) filter (where l.origem_vinculo = 'GESTAO_MANUAL'))::integer n_gestao_manual,
           coalesce(sum(c.log_baixada), 0)::integer     log_baixada,
           coalesce(sum(c.log_sem_parcela), 0)::integer log_sem_parcela,
           coalesce(sum(c.log_erro), 0)::integer        log_erro,
           array_remove(array_agg(distinct l.pagamento_id), null)  pagamento_ids,
           array_remove(array_agg(distinct l.titulo_numero), null) titulos
      from base b
      left join linhas l on l.sol_id = b.id
      left join corrob c on c.sol_id = b.id and c.pagamento_id = l.pagamento_id
     group by 1, 2, 3, 4, 5, 6, 7
  )
  select a.id, a.status, a.aluno_id, a.aluno_nome, a.data_pagamento,
         a.valor_informado, a.origem_divida,
         case
           when a.n_linhas = 0                                       then 'DESCONHECIDA'
           when a.n_contradiz > 0                                    then 'DIVERGENCIA'
           when a.n_baixado > 0 and a.n_baixado < a.n_linhas          then 'DIVERGENCIA'
           when a.n_baixado = a.n_linhas
            and a.n_identificador + a.n_gestao_manual = a.n_linhas    then 'BAIXA_CONFIRMADA'
           when a.n_sem_veredito = a.n_linhas                         then 'DESCONHECIDA'
           else 'PAGAMENTO_INFORMADO'
         end,
         case
           when a.n_linhas = 0                                       then 'SEM_LINHA_NO_ARQUIVO'
           when a.n_contradiz > 0                                    then 'MOTOR_CONTRADIZ'
           when a.n_baixado > 0 and a.n_baixado < a.n_linhas          then 'BAIXA_PARCIAL'
           when a.n_baixado = a.n_linhas
            and a.n_identificador + a.n_gestao_manual = a.n_linhas    then 'TODAS_BAIXADAS_POR_IDENTIFICADOR'
           when a.n_sem_veredito = a.n_linhas
            and a.log_sem_parcela > 0                                 then 'MOTOR_NAO_ACHOU_PARCELA'
           when a.n_sem_veredito = a.n_linhas                         then 'MOTOR_NUNCA_RODOU'
           else 'INFORMADO_SEM_TITULO_PROVADO'
         end,
         a.n_linhas, a.soma_arquivo,
         (round(a.valor_informado, 2) = a.soma_arquivo),
         a.n_baixado, a.n_contradiz, a.n_sem_veredito,
         a.n_identificador, a.n_gestao_manual,
         a.log_baixada, a.log_sem_parcela, a.log_erro,
         a.pagamento_ids, a.titulos
    from agg a;
end;
$function$;

comment on function public.confirmacao_classificar_por_evidencia(boolean) is
  'F1.a -- SO LEITURA. Classifica cada solicitacao da fila unica de Confirmacao de Pagamento em PAGAMENTO_INFORMADO / BAIXA_CONFIRMADA / DIVERGENCIA / DESCONHECIDA, por precedencia fixa, a partir do veredito que o motor carimbou na linha do arquivo Santander (pagamentos.origem_vinculo + status_conciliacao) e da corroboracao independente em baixa_automatica_log. NAO le a Prime: paidAmount nao e caixa e situacao de titulo nao e exposta (docs/integracoes/prime-mapa-fontes-verdade.md). NAO grava, NAO confirma, NAO baixa, NAO vincula, NAO tira ninguem da cobranca. Importar arquivo nao comprova pagamento.';

revoke all on function public.confirmacao_classificar_por_evidencia(boolean) from public, anon;
grant execute on function public.confirmacao_classificar_por_evidencia(boolean) to authenticated;

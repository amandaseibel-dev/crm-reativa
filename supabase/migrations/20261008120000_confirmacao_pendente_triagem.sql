-- TRIAGEM DOS ALUNOS COM CONFIRMACAO DE PAGAMENTO PENDENTE.
--
-- Pedido da gestao em 08/10/2026: priorizar a fila de confirmacao mostrando, na
-- propria aba, o que cada decisao vai produzir -- quais encerram a cobranca,
-- quais devolvem saldo elegivel para retorno e quais tem OUTRO bloqueio que
-- sobrevive a decisao. E conferir se os elegiveis estao de fato na mao de um
-- operador.
--
-- SO LEITURA. Esta funcao nao libera ninguem, nao remove suspensao,
-- cancelamento nem "nao acionar", nao mexe em caso, saldo, acordo, parcela,
-- pagamento ou responsavel. Nenhuma regra de negocio nova: ela LE os mesmos
-- campos que a Fila Operacional e a propria aba ja usam para decidir.
--
-- ===================== POR QUE A CLASSIFICACAO E ESTA ======================
-- MEDIDO em producao em 08/10/2026, somente leitura, sobre as 232 solicitacoes
-- abertas (201 alunos distintos):
--
--   * NINGUEM tem saldo zerado. `ENCERRA_COBRANCA` existe como categoria e
--     hoje volta ZERO. Isso importa: "encerrar a cobranca" nao e um estado que
--     se deduza do dado, e sim uma DECISAO de gestao (pago fora do sistema,
--     conciliacao bancaria, saldo residual indevido) -- exatamente o que
--     `confirmar_saldo_zero_retirar_filas` exige motivo escrito para fazer. A
--     funcao nao sugere essa decisao para ninguem; ela so mostra quem JA esta
--     sem saldo a cobrar.
--
--   * `nao_acionar` e ZERO nos 201. O bloqueio real mora em outro lugar: caso
--     `encerrado_operacional`, ou status normalizado em ENCERRADO / SUSPENSAO
--     COBRANCA / ACORDO CANCELADO / CANCELADO / CANCELAMENTO COBRANCA /
--     JURIDICO, ou caso sem operador. A lista de status bloqueantes e a MESMA
--     que `carteira_saldo_historico_recalcular` usa para tirar o aluno do saldo
--     cobravel, mais SUSPENSAO COBRANCA e ACORDO CANCELADO, que aparecem nesta
--     populacao.
--
-- ===================== O QUE "DISPONIVEL AO OPERADOR" MEDE =================
-- Enquanto a confirmacao esta ABERTA, o aluno esta protegido e sai da Fila
-- Operacional de proposito -- e o desenho de
-- `docs/PROTECAO-CONFIRMACAO-FINANCEIRA.md`, e nada aqui o altera. A pergunta
-- util e outra: resolvida a confirmacao, o caso cai na mao de QUEM?
--
-- MEDIDO: dos 168 elegiveis, 135 estao com operador ativo, 28 estao parados em
-- `carteira.geral@reativa.local` -- a Carteira Geral, que e `ativo = false` por
-- desenho justamente para ficar fora de todo seletor de pessoa -- e 5 estao com
-- perfil `gerencia`. Ou seja: 33 dos "elegiveis" NAO voltam para operador
-- nenhum ao serem resolvidos; eles precisam de decisao de DISTRIBUICAO, que e
-- outra frente. A funcao separa os tres para a aba poder dizer isso.
--
-- ===================== O QUE A DECISAO DE CONFIRMACAO FAZ =================
-- Lido do fluxo que a aba ja chama, nao inventado:
--   quitar_e_encerrar_caso ............... quita, zera, sai das filas e NAO
--                                          volta pro operador -> ENCERRA
--   confirmar_saldo_zero_retirar_filas ... retira de carteira/fila/retorno/
--                                          distribuicao, preserva financeiro e
--                                          historico, exige motivo, so gestao
--                                          -> ENCERRA
--   confirmar_pagamento_solicitacao ...... aplica o pagamento; o que sobrar de
--                                          saldo volta a ser cobravel
--   rejeicao ............................. o titulo volta a ser cobrado
-- A funcao NAO escolhe decisao para ninguem: ela diz o que sobra depois.
--
-- Reversivel: supabase/rollbacks/20261008120000_confirmacao_pendente_triagem.rollback.sql

create or replace function public.confirmacao_pendente_triagem()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  -- Mesmo portao da aba: e tela de gestao financeira.
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  with pend as (
    -- Os DOIS estados abertos, como a protecao ja olha. Hoje
    -- PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO tem zero linhas, mas deixar o
    -- filtro fechado em um unico estado seria repetir o bug que a protecao de
    -- 20/09 corrigiu.
    select distinct s.aluno_id::uuid as aluno_id
      from public.solicitacoes_confirmacao_pagamento s
     where s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
  ),
  -- Um registro por aluno, resumindo os casos dele. Aluno com dois casos conta
  -- como livre se ALGUM caso estiver livre: e esse que o operador alcanca.
  caso as (
    select p.aluno_id,
           bool_or(coalesce(c.encerrado_operacional,false))                     as tem_encerrado,
           bool_or(coalesce(c.nao_acionar,false))                               as tem_nao_acionar,
           bool_or(public.normalizar_status_acionamento(
                     coalesce(c.status_atual,c.status_acionamento,c.status_jornada))
                   = any(array['ENCERRADO','SUSPENSAO COBRANCA','ACORDO CANCELADO',
                               'CANCELADO','CANCELAMENTO COBRANCA','JURIDICO']))  as tem_status_bloq,
           max(case when not coalesce(c.encerrado_operacional,false)
                     and not coalesce(c.nao_acionar,false)
                     and not (public.normalizar_status_acionamento(
                                coalesce(c.status_atual,c.status_acionamento,c.status_jornada))
                              = any(array['ENCERRADO','SUSPENSAO COBRANCA','ACORDO CANCELADO',
                                          'CANCELADO','CANCELAMENTO COBRANCA','JURIDICO']))
                    then nullif(btrim(coalesce(c.operador_email,'')), '') end)   as operador_do_caso_livre
      from pend p
      join public.casos c on c.aluno_id = p.aluno_id
     group by p.aluno_id
  ),
  -- A solicitacao aberta mais recente de cada aluno, para datar a espera.
  sol as (
    select distinct on (s.aluno_id::uuid)
           s.aluno_id::uuid as aluno_id, s.id as solicitacao_id, s.status,
           coalesce(s.valor_informado,0) as valor_informado, s.criado_em,
           s.operador_email as operador_da_solicitacao
      from public.solicitacoes_confirmacao_pagamento s
     where s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
     order by s.aluno_id::uuid, s.criado_em desc
  ),
  cls as (
    select p.aluno_id,
           a.nome, a.cpf,
           coalesce(a.saldo_total,0)  as saldo,
           so.solicitacao_id, so.status, so.valor_informado, so.criado_em,
           k.tem_encerrado, k.tem_nao_acionar, k.tem_status_bloq,
           k.operador_do_caso_livre,
           u.ativo  as operador_ativo,
           u.perfil as operador_perfil,
           case
             -- OUTRO BLOQUEIO primeiro: ele sobrevive a decisao, entao decide a
             -- classificacao independentemente do saldo.
             when k.operador_do_caso_livre is null then 'OUTRO_BLOQUEIO'
             when coalesce(a.saldo_total,0) <= 0   then 'ENCERRA_COBRANCA'
             else 'DEVOLVE_SALDO'
           end as grupo,
           -- Dentro dos elegiveis: a decisao os devolve a QUEM?
           case
             when k.operador_do_caso_livre is null then null
             when coalesce(u.ativo,false) and u.perfil = 'operador' then 'OPERADOR_ATIVO'
             when k.operador_do_caso_livre = 'carteira.geral@reativa.local' then 'CARTEIRA_GERAL'
             else 'NAO_E_OPERADOR_ATIVO'
           end as destino
      from pend p
      left join public.alunos a on a.id = p.aluno_id
      left join caso k on k.aluno_id = p.aluno_id
      left join sol so on so.aluno_id = p.aluno_id
      left join public.usuarios u on lower(u.email) = lower(k.operador_do_caso_livre)
  )
  select jsonb_build_object(
    'gerado_em', now(),
    'fonte', 'solicitacoes_confirmacao_pagamento + casos + alunos, ao vivo',
    'alunos_pendentes', (select count(*) from cls),
    'solicitacoes_abertas',
      (select count(*) from public.solicitacoes_confirmacao_pagamento
        where status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')),
    'grupos', (select coalesce(jsonb_agg(g order by g->>'grupo'), '[]'::jsonb) from (
        select jsonb_build_object(
                 'grupo', grupo,
                 'alunos', count(*),
                 'saldo', round(sum(saldo), 2),
                 'valor_informado', round(sum(valor_informado), 2),
                 'espera_mais_antiga', min(criado_em),
                 'com_caso_encerrado', count(*) filter (where tem_encerrado),
                 'com_status_bloqueio', count(*) filter (where tem_status_bloq),
                 'com_nao_acionar', count(*) filter (where tem_nao_acionar),
                 'sem_operador', count(*) filter (where operador_do_caso_livre is null)) g
          from cls group by grupo) x),
    'destino_dos_elegiveis', (select coalesce(jsonb_agg(d order by d->>'destino'), '[]'::jsonb) from (
        select jsonb_build_object('destino', destino, 'alunos', count(*),
                                  'saldo', round(sum(saldo), 2)) d
          from cls where destino is not null group by destino) y),
    -- A lista individual: 201 alunos hoje, pequena de proposito. A aba pagina
    -- no front; nenhuma consulta ampla e refeita por linha.
    'itens', (select coalesce(jsonb_agg(jsonb_build_object(
                 'aluno_id', aluno_id, 'nome', nome, 'cpf', cpf,
                 'saldo', saldo, 'valor_informado', valor_informado,
                 'solicitacao_id', solicitacao_id, 'status', status,
                 'criado_em', criado_em,
                 'grupo', grupo, 'destino', destino,
                 'operador', operador_do_caso_livre,
                 'operador_ativo', operador_ativo, 'operador_perfil', operador_perfil,
                 'caso_encerrado', tem_encerrado, 'status_bloqueio', tem_status_bloq,
                 'nao_acionar', tem_nao_acionar)
                 order by grupo, saldo desc), '[]'::jsonb) from cls)
  ) into v_out;

  return v_out;
end;
$function$;

comment on function public.confirmacao_pendente_triagem() is
  'Triagem SO LEITURA dos alunos com confirmacao de pagamento aberta: separa quem fica '
  'sem saldo a cobrar depois da decisao (ENCERRA_COBRANCA), quem devolve saldo elegivel '
  'para retorno (DEVOLVE_SALDO) e quem tem OUTRO bloqueio que sobrevive a decisao '
  '(OUTRO_BLOQUEIO -- caso encerrado, status de suspensao/cancelamento/juridico, '
  'nao_acionar ou caso sem operador). Entre os elegiveis, diz se a devolucao cai em '
  'operador ativo, na Carteira Geral ou em quem nao e operador. NAO libera ninguem e NAO '
  'remove bloqueio nenhum.';

revoke all on function public.confirmacao_pendente_triagem() from public, anon;
grant execute on function public.confirmacao_pendente_triagem() to authenticated, service_role;

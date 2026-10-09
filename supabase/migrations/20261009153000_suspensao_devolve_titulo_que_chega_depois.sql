-- SUSPENSAO DE COBRANCA: o titulo que CHEGA em EM_CONFIRMACAO tambem e devolvido.
--
-- Pedido da gestao em 09/10/2026, a partir da aluna Jessica Linck (e07f8053):
-- "ao registrar a tabulacao SUSPENSAO DE COBRANCA os titulos vinculados a
-- suspensao devem ficar DEVOLVIDO -- isso nao e recuperacao financeira da
-- ReATIVA e nao pode seguir como valor a confirmar, negociado ou quitado.
-- Ajustar tambem os casos anteriores, preservando os titulos que nao fazem
-- parte da suspensao."
--
-- O QUE JA FUNCIONAVA. Desde 20261008170636/20261009080652 a tabulacao devolve:
-- `trg_tabulacao_efeito_financeiro` (em `alunos.status_jornada`) chama
-- `parcela_efeito_sem_pagamento_aplicar`, que devolve pelo escritor unico
-- `titulo_devolver_da_confirmacao`. Na suspensao a selecao e SOMENTE
-- EM_CONFIRMACAO -- titulo ABERTO/NEGOCIADO continua divida viva, porque
-- suspensao suspende a cobranca, nao encerra a divida.
--
-- O FURO, MEDIDO NA PROPRIA JESSICA. A devolucao olha o estado do titulo NO
-- INSTANTE da tabulacao. A ordem dos eventos dela foi a inversa:
--
--   24/09/2026 18:26  FINALIZACAO_ATENDIMENTO -> SUSPENSAO_COBRANCA
--   26/09/2026 02:50  rotina da Prime move 3 titulos ABERTO -> EM_CONFIRMACAO
--
-- No dia 24 os titulos estavam ABERTO, e suspensao nao devolve ABERTO -- certo.
-- No dia 26 eles entraram em EM_CONFIRMACAO e ninguem mais passou por eles:
-- a tabulacao nao foi registrada de novo, e `prime_liquidacao_suspender` nao
-- conhece o portao administrativo. Resultado em 09/10/2026: 34 alunos sob
-- suspensao com 59 titulos em EM_CONFIRMACAO, R$ 68.944,38, os 59 com pendencia
-- PENDENTE na Conferencia Prime -- decisao pedida sobre caso que ninguem vai
-- mais cobrar.
--
-- A CORRECAO, EM DUAS PECAS, SEM REGRA NOVA:
--   1. um gatilho fecha a ordem inversa -- titulo que ENTRA em EM_CONFIRMACAO
--      com o aluno sob suspensao e devolvido na hora, pelo MESMO escritor unico;
--   2. uma funcao retroativa aplica a regra aos casos anteriores, pelo MESMO
--      escritor unico, idempotente e reexecutavel.
--
-- O QUE ESTA MIGRATION NAO FAZ: nao muda QUAIS titulos a suspensao devolve
-- (segue so EM_CONFIRMACAO), nao cria vocabulario novo (`devolucao_origem` =
-- 'SUSPENSAO_COBRANCA', como o motor ja grava, para que
-- `suspensao_cobranca_reativar` continue restaurando tudo), nao toca parcela,
-- pagamento, baixa, honorario ou `quitado_em`.

-- ---------------------------------------------------------------------------
-- 1. O GATILHO: chegar em EM_CONFIRMACAO sob suspensao ja e devolucao
-- ---------------------------------------------------------------------------
-- Por que gatilho e nao um remendo em `prime_liquidacao_suspender`: EM_CONFIRMACAO
-- tem mais de uma porta de entrada (`prime_liquidacao_suspender`,
-- `prime_liquidacao_reavaliar_pendentes`, `prime_conferencia_*`). Um gatilho na
-- tabela cobre todas de uma vez -- a mesma razao pela qual
-- `titulos_devolviveis_por_desfecho` virou clausula unica em 09/10/2026.
--
-- TRES GUARDAS, cada uma por um motivo medido:
--
--   (i) `parcela_efeito_sem_pagamento.aplicando = on` -- quem esta em voo e o
--       motor ou a REATIVACAO. Esta e a guarda critica: ao levantar a suspensao,
--       `suspensao_cobranca_reativar` restaura o titulo para EM_CONFIRMACAO
--       ANTES de limpar o status do aluno; sem esta linha o gatilho devolveria o
--       titulo de volta no mesmo instante e a TRAVA final da reativacao
--       ("titulo continua DEVOLVIDO por SUSPENSAO_COBRANCA") abortaria TODA a
--       reativacao. E a mesma guarda que `trg_tabulacao_efeito_financeiro` usa.
--
--  (ii) so SUSPENSAO_COBRANCA, lido de `aluno_bloqueio_administrativo` -- a
--       fonte unica do portao administrativo. CANCELAMENTO_COBRANCA e JURIDICO
--       ficam de fora de proposito: cancelamento e definitivo e tem o seu
--       proprio caminho pelas cinco tabulacoes, e juridico nao e desfecho.
--
-- (iii) somente gestao ou sistema. `titulo_devolver_da_confirmacao` RECUSA com
--       42501 quem nao e gestao, e as portas da Conferencia Prime sao
--       executaveis por `authenticated`. Sem esta guarda, um operador comum que
--       mexesse num titulo de aluno suspenso receberia erro de permissao e
--       PERDERIA a propria acao. O que escapar por aqui nao fica perdido: cai
--       em auditoria e a funcao retroativa da secao 2 recolhe depois.
create or replace function public._titulo_sob_suspensao_devolve()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
begin
  -- (i) motor ou reativacao em voo: quem manda e a funcao, nao este gatilho.
  if coalesce(current_setting('parcela_efeito_sem_pagamento.aplicando', true), '') = 'on' then
    return null;
  end if;

  -- (ii) o portao tem de ser a suspensao.
  if public.aluno_bloqueio_administrativo(new.aluno_id) is distinct from 'SUSPENSAO_COBRANCA' then
    return null;
  end if;

  -- (iii) quem nao e gestao nem sistema nao devolve -- mas o furo fica visivel.
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values (coalesce(nullif(lower(coalesce(auth.jwt() ->> 'email','')),''), 'desconhecido'),
            'TITULO_EM_CONFIRMACAO_SOB_SUSPENSAO_NAO_DEVOLVIDO', 'acordos_titulos', new.id,
            jsonb_build_object('aluno_id', new.aluno_id, 'documento', new.documento,
                               'por_que', 'quem registrou nao e gestao nem sistema; recolher com suspensao_cobranca_devolver_em_confirmacao'));
    return null;
  end if;

  perform public.titulo_devolver_da_confirmacao(
    new.id,
    'SUSPENSAO_COBRANCA',
    'Titulo entrou em confirmacao com a cobranca do aluno JA suspensa (SUSPENSAO_COBRANCA). '
      || 'A suspensao finalizou o caso: nao ha o que confirmar e nao ha recuperacao da ReATIVA.');

  return null;
end;
$function$;

comment on function public._titulo_sob_suspensao_devolve() is
  'Titulo que ENTRA em EM_CONFIRMACAO com o aluno sob SUSPENSAO_COBRANCA e devolvido na hora pelo escritor unico titulo_devolver_da_confirmacao. Fecha a ordem inversa (suspensao primeiro, titulo depois), que era o caso da Jessica Linck. Nao age com o motor ou a reativacao em voo, nem para quem nao e gestao ou sistema -- nesse caso registra em auditoria.';

-- AFTER, e nao BEFORE: a devolucao tem de ver a linha ja gravada em
-- EM_CONFIRMACAO (`titulo_devolver_da_confirmacao` le a linha com `for update`).
-- Sem recursao: a escrita do helper deixa `situacao = DEVOLVIDO`, e a clausula
-- WHEN so dispara em EM_CONFIRMACAO.
drop trigger if exists trg_titulo_sob_suspensao_devolve on public.acordos_titulos;
create trigger trg_titulo_sob_suspensao_devolve
  after insert or update of situacao on public.acordos_titulos
  for each row
  when (upper(coalesce(new.situacao,'')) = 'EM_CONFIRMACAO')
  execute function public._titulo_sob_suspensao_devolve();

-- ---------------------------------------------------------------------------
-- 2. O RETROATIVO: os casos anteriores, pela MESMA regra
-- ---------------------------------------------------------------------------
-- Nao e um UPDATE em massa de proposito. Passa titulo por titulo pelo escritor
-- unico, que ja tem as recusas de seguranca (terminal, pago, liquidado
-- oficialmente na Prime), encerra a pendencia da Conferencia Prime, registra em
-- `aluno_movimentacoes` e `auditoria` e confere as duas TRAVAS -- estado final e
-- integridade financeira (6 tabelas + soma de honorarios).
--
-- O ESCOPO E O MESMO DO GATILHO: titulo EM_CONFIRMACAO de aluno cujo portao
-- administrativo e SUSPENSAO_COBRANCA. Titulo ABERTO, NEGOCIADO, DUPLICADA,
-- PAGO ou QUITADO fica INTOCADO -- e isto que cumpre o "preservando os titulos
-- que nao fazem parte da suspensao".
--
-- Idempotente: reexecutar nao devolve duas vezes (o helper ignora o que ja esta
-- DEVOLVIDO). `p_dry_run = true` e o padrao e nao escreve nada.
create or replace function public.suspensao_cobranca_devolver_em_confirmacao(
  p_motivo   text,
  p_aluno_id uuid default null,
  p_dry_run  boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sistema boolean := coalesce(auth.role(),'') = 'service_role' or auth.jwt() is null;
  v_qtd int := 0; v_val numeric := 0; v_alunos int := 0;
  v_pres_qtd int := 0; v_pres_val numeric := 0;
  v_ign int := 0;
  v_t record; v_res jsonb;
begin
  if not (v_sistema or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'Devolver titulo por suspensao e decisao da gestao. Registre a solicitacao para Amanda, Fernanda ou Amanda ADM.'
      using errcode = '42501';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatorio: a devolucao precisa dizer o que a gestao autorizou e quando.'
      using errcode = '22023';
  end if;

  -- O que FICA, contado junto e na mesma passada: um retroativo que so informa
  -- o que mexeu nao deixa conferir o que preservou.
  select count(*), coalesce(sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                                               t.valor_em_aberto, t.valor_original, 0),2)),0)
    into v_pres_qtd, v_pres_val
    from public.acordos_titulos t
   where (p_aluno_id is null or t.aluno_id = p_aluno_id)
     and upper(coalesce(t.situacao,'')) <> 'EM_CONFIRMACAO'
     and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA';

  if p_dry_run then
    select count(*), count(distinct t.aluno_id),
           coalesce(sum(round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                                       t.valor_em_aberto, t.valor_original, 0),2)),0)
      into v_qtd, v_alunos, v_val
      from public.acordos_titulos t
     where (p_aluno_id is null or t.aluno_id = p_aluno_id)
       and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
       and coalesce(t.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL'
       and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA';

    return jsonb_build_object('ok', true, 'dry_run', true,
      'alunos', v_alunos, 'titulos_a_devolver_qtd', v_qtd,
      'titulos_a_devolver_valor', round(v_val,2),
      'titulos_preservados_qtd', v_pres_qtd,
      'titulos_preservados_valor', round(v_pres_val,2));
  end if;

  for v_t in
    select t.id, t.aluno_id,
           round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido,
                          t.valor_em_aberto, t.valor_original, 0),2) as valor
      from public.acordos_titulos t
     where (p_aluno_id is null or t.aluno_id = p_aluno_id)
       and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
       and coalesce(t.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL'
       and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA'
     order by t.aluno_id, t.id
  loop
    v_res := public.titulo_devolver_da_confirmacao(v_t.id, 'SUSPENSAO_COBRANCA', btrim(p_motivo));
    if coalesce((v_res->>'ignorado')::boolean, false) then
      v_ign := v_ign + 1;
    else
      v_qtd := v_qtd + 1; v_val := v_val + coalesce(v_t.valor,0);
    end if;
  end loop;

  select count(distinct aluno_id) into v_alunos
    from public.acordos_titulos
   where (p_aluno_id is null or aluno_id = p_aluno_id)
     and upper(coalesce(situacao,'')) = 'DEVOLVIDO'
     and devolucao_origem = 'SUSPENSAO_COBRANCA';

  -- TRAVA. Nao pode sobrar titulo em EM_CONFIRMACAO sob suspensao no escopo
  -- rodado: se sobrar, a correcao nao corrigiu e e melhor abortar do que
  -- devolver ok: true sobre a mesma pendencia de antes.
  if exists (select 1 from public.acordos_titulos t
              where (p_aluno_id is null or t.aluno_id = p_aluno_id)
                and upper(coalesce(t.situacao,'')) = 'EM_CONFIRMACAO'
                and coalesce(t.origem_liquidacao,'') <> 'PRIME_LIQUIDACAO_OFICIAL'
                and public.aluno_bloqueio_administrativo(t.aluno_id) = 'SUSPENSAO_COBRANCA') then
    raise exception 'TRAVA: sobrou titulo EM_CONFIRMACAO sob SUSPENSAO_COBRANCA depois do retroativo. Nada foi confirmado.'
      using errcode = 'P0001';
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(lower(coalesce(auth.jwt() ->> 'email','')),''), 'sistema'),
          'SUSPENSAO_RETROATIVO_TITULOS_DEVOLVIDOS', 'acordos_titulos', null,
          jsonb_build_object('escopo', coalesce(p_aluno_id::text, 'todos os alunos sob suspensao'),
                             'titulos_devolvidos', v_qtd, 'valor', round(v_val,2),
                             'titulos_ignorados', v_ign,
                             'titulos_preservados', v_pres_qtd,
                             'motivo', btrim(p_motivo), 'sem_efeito_financeiro', true));

  return jsonb_build_object('ok', true, 'dry_run', false,
    'alunos_com_titulo_devolvido_por_suspensao', v_alunos,
    'titulos_devolvidos_qtd', v_qtd, 'titulos_devolvidos_valor', round(v_val,2),
    'titulos_ignorados_qtd', v_ign,
    'titulos_preservados_qtd', v_pres_qtd,
    'titulos_preservados_valor', round(v_pres_val,2));
end;
$function$;

comment on function public.suspensao_cobranca_devolver_em_confirmacao(text, uuid, boolean) is
  'Retroativo da suspensao: devolve, pelo escritor unico titulo_devolver_da_confirmacao, todo titulo EM_CONFIRMACAO de aluno cujo portao administrativo e SUSPENSAO_COBRANCA. Preserva ABERTO, NEGOCIADO, DUPLICADA, PAGO e QUITADO, e nunca toca titulo liquidado oficialmente na Prime. Idempotente, reexecutavel, p_dry_run = true por padrao. TRAVA: aborta se sobrar EM_CONFIRMACAO sob suspensao no escopo. Somente gestao ou sistema.';

revoke all on function public.suspensao_cobranca_devolver_em_confirmacao(text, uuid, boolean) from public, anon;
grant execute on function public.suspensao_cobranca_devolver_em_confirmacao(text, uuid, boolean) to authenticated, service_role;

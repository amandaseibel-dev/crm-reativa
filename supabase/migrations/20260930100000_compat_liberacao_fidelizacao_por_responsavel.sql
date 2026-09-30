-- COMPATIBILIDADE DO CAMINHO DE LIBERACAO COM A FIDELIZACAO POR RESPONSAVEL.
--
-- O QUE ESTA MIGRATION FAZ: cria UMA funcao nova,
-- internal.liberar_fidelizacao_caso_v2. Nada mais. Nenhuma funcao existente e
-- alterada, nenhum gatilho, nenhum cron, nenhuma ACL de objeto que ja existe.
--
-- ---------------------------------------------------------------------------
-- O PROBLEMA QUE ELA RESOLVE
--
-- A migration 20260929101500_fidelizacao_10_dias_fechar_caminhos_automaticos
-- colocou dentro de public.liberar_fidelizacao_caso:
--
--     if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento)
--        then return false; end if;
--
-- Essa guarda le o relogio do CASO (casos.data_ultimo_acionamento), que e
-- renovado por acionamento de QUALQUER autor -- inclusive acao massiva da
-- gestao. Ja a regra nova (20260930090000) conta pelo relogio do DONO
-- (casos.fidelizacao_inicio), que so o proprio responsavel renova.
--
-- Resultado medido em 30/09/2026: um caso que casos_elegiveis_liberacao_
-- fidelizacao_v2() considera elegivel e RECUSADO em silencio por
-- liberar_fidelizacao_caso (`return false`) quando o relogio do CASO esta
-- dentro dos 10 dias. Sem tratar isso, ativar a regra nova produziria
-- elegibilidade calculada e ZERO liberacao.
--
-- ---------------------------------------------------------------------------
-- POR QUE FUNCAO NOVA, E NAO UM PARAMETRO NA EXISTENTE
--
-- Acrescentar `p_modo_fidelizacao text default 'vigente'` a
-- public.liberar_fidelizacao_caso(uuid,text,text) criaria um OVERLOAD
-- AMBIGUO: a chamada posicional de 3 argumentos que public.liberar_casos_
-- fidelizacao_vencida ja faz passaria a falhar com
-- "function liberar_fidelizacao_caso(...) is not unique" -- comprovado em
-- PostgreSQL real. Isso derrubaria o cron id 8 (fidelizacao_liberar_vencidos,
-- 20 8 * * *) e o botao da tela SaudeDaBase. Evitar exigiria dropar a versao de
-- 3 argumentos antes, mexendo em ACL e dependencias.
--
-- Funcao separada mantem public.liberar_fidelizacao_caso BYTE A BYTE. O md5 do
-- corpo continua 1c00df7f23b6c93161ddceab1e8bfbcc, e o teste de nao regressao
-- compara contra producao.
--
-- ---------------------------------------------------------------------------
-- POR QUE NO SCHEMA `internal`
--
-- Medido em producao: o schema `internal` NAO tem USAGE para anon,
-- authenticated nem service_role -- so postgres e reativa_responsavel_executor.
-- Logo a semantica nova e INALCANCAVEL pela API do PostgREST: nenhum usuario
-- logado consegue aciona-la antes da ativacao oficial, mesmo querendo. Nao
-- depende de convencao nem de ninguem "nao chamar errado".
-- O cron roda como `postgres` e alcanca normalmente, quando for a hora.
--
-- NAO se cria wrapper publico nesta etapa, de proposito.
--
-- ---------------------------------------------------------------------------
-- DUPLICACAO DELIBERADA
--
-- O nucleo de escrita (update casos, update alunos, insert historico) fica em
-- dois lugares. E o preco de nao tocar na v1 agora. Um teste de CONTRATO em
-- supabase/tests/compat_liberacao_fidelizacao_comportamento.test.js compara os
-- efeitos observaveis dos dois caminhos, campo por campo, em cenario onde as
-- duas regras permitem liberar -- se alguem mudar o nucleo de um lado e
-- esquecer o outro, o teste quebra.
--
-- QUANDO A HARMONIZACAO DAS DEFINICOES DE FIDELIZACAO acontecer (frente
-- separada), o certo passa a ser extrair um nucleo comum e deixar as duas
-- entradas chamando-o -- aí havera UMA guarda, nao duas, e a duplicacao deixa
-- de se justificar.
--
-- ---------------------------------------------------------------------------
-- PRE-REQUISITO DE APLICACAO
--
-- Esta funcao le casos.fidelizacao_inicio e chama public.fidelizacao_vencida,
-- criadas por 20260930090000_fidelizacao_por_responsavel_atual.sql. O corpo e
-- plpgsql, entao a funcao COMPILA sem eles -- mas so EXECUTA corretamente
-- depois daquela migration.
--
-- ORDEM FUTURA, e nenhum passo e automatico:
--   1. aplicar 20260930090000 (infraestrutura passiva)
--   2. sem ativacao
--   3. aplicar esta migration (compatibilidade do caminho de liberacao)
--   4. backfill    -- select public.fidelizacao_backfill_corte();
--   5. sombra      -- 3 dias uteis, select public.fidelizacao_sombra_registrar();
--   6. so entao considerar a ativacao (modo 'ativo' + cron apontando para a v2)
--
-- Nada aqui acopla as etapas: esta migration nao chama backfill, nao chama
-- sombra, nao mexe em cron e nao muda o `modo`.
--
-- Rollback: supabase/rollbacks/20260930100000_compat_liberacao_fidelizacao_por_responsavel.rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- internal.liberar_fidelizacao_caso_v2
--
-- Espelha a escrita de public.liberar_fidelizacao_caso e troca SO a guarda de
-- fidelizacao. Diferencas em relacao a v1, todas intencionais:
--
--   1. a guarda le fidelizacao_inicio (relogio do DONO), nunca
--      data_ultimo_acionamento;
--   2. exige fidelizacao_inicio NOT NULL -- caso sem backfill nao e liberado;
--   3. CHECA caso_protegido_redistribuicao AQUI DENTRO. A v1 nao checa: ela
--      confia em quem monta a lista (casos_elegiveis_liberacao_fidelizacao).
--      Esta versao nao confia no chamador -- e a licao da propria migration de
--      29/09/2026, que existiu porque a guarda dos 10 dias vivia so na lista.
--      E guarda ADICIONAL: nunca libera algo que a v1 liberaria e que fosse
--      protegido; jamais o contrario.
--
-- Motivo e autor tem valores proprios, para o historico distinguir os caminhos.
-- ---------------------------------------------------------------------------
create or replace function internal.liberar_fidelizacao_caso_v2(
  p_caso_id uuid,
  p_motivo  text default 'FIDELIZACAO_EXPIRADA_DONO',
  p_autor   text default 'sistema_fidelizacao_v2')
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_c record;
begin
  select * into v_c from public.casos where id = p_caso_id for update;
  if not found or v_c.operador_email is null then return false; end if;

  -- RELOGIO DO DONO. Sem relogio (backfill nao rodou), nao libera.
  if v_c.fidelizacao_inicio is null then return false; end if;
  if not public.fidelizacao_vencida(v_c.fidelizacao_inicio) then return false; end if;

  -- PROTECOES SOBERANAS, checadas aqui e nao no chamador.
  if public.caso_protegido_redistribuicao(v_c.cpf_limpo, v_c.status_acionamento,
       v_c.nao_acionar, v_c.status_financeiro, v_c.valor_pago, v_c.quitado_em,
       v_c.valor_quitado) then
    return false;
  end if;

  -- A PARTIR DAQUI, escrita IDENTICA a de public.liberar_fidelizacao_caso.
  -- Qualquer mudanca aqui precisa ser espelhada la, e vice-versa: o teste de
  -- contrato compara os efeitos dos dois caminhos.
  update public.casos set operador_email=null, operador_nome=null, operador=null,
    caso_atualizado_por=p_autor, caso_atualizado_em=now()
  where id = p_caso_id;

  if v_c.aluno_id is not null then
    update public.alunos set responsavel_atual_email=null, responsavel_atual_nome=null
    where id = v_c.aluno_id;
  end if;

  insert into public.historico_operadores_alunos
    (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome,
     operador_anterior_email, observacao, criado_em)
  values (v_c.chave_unificacao, v_c.nome, v_c.cpf, p_motivo, v_c.operador_nome,
    v_c.operador_email,
    'Fidelizacao do responsavel atual expirada (inicio '
      || coalesce(v_c.fidelizacao_inicio::text,'nunca')
      || ' + ' || public.fidelizacao_dias()::text
      || 'd, data local de Brasilia). Caso LIVRE, sem atribuicao automatica. '
      || 'Responsavel anterior preservado.', now());

  return true;
end;
$function$;

comment on function internal.liberar_fidelizacao_caso_v2(uuid,text,text) is
  'Libera caso por fidelizacao do RESPONSAVEL ATUAL (casos.fidelizacao_inicio). Nao le data_ultimo_acionamento. Vive em internal de proposito: sem USAGE para anon/authenticated/service_role, inalcancavel pela API. public.liberar_fidelizacao_caso continua intacta e e quem o cron vigente usa.';

-- ACL: `internal` nao tem USAGE para os papeis da API, entao nao ha o que
-- revogar de anon/authenticated. Ainda assim, explicito: nada de EXECUTE para
-- eles. Nenhum grant novo a authenticated, por decisao.
revoke all on function internal.liberar_fidelizacao_caso_v2(uuid,text,text) from public;

commit;

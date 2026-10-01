-- FIDELIZACAO DE 10 DIAS: fechar os caminhos automaticos que ainda retiravam
-- caso de operador dentro do prazo.
--
-- REGRA (Amanda): o acionamento valido grava `casos.data_ultimo_acionamento`;
-- desse dia ate completar 10 dias o caso fica com o responsavel atual; no 11o
-- dia, sem novo acionamento, volta a ser elegivel; acionamento novo reinicia a
-- janela. Fonte unica: public.caso_dentro_prazo_fidelizacao(date).
--
-- LEVANTAMENTO (producao, 29/09/2026): 34 funcoes escrevem casos.operador_email.
-- Ja respeitavam os 10 dias: calibragem_executar_simulacao,
-- calibragem_executar_nivelamento, calibragem_executar_nivelamento_lote_impl,
-- trg_impor_teto_operador, reforcar_teto_operadores, nivelar_medias_progressivo,
-- redistribuir_casos_operadores e _faixas.
--
-- Esta migration fecha as duas que faltavam e que rodam SOZINHAS por cron:
--
--   1) liberar_fidelizacao_caso  -- a ponta que de fato solta o caso. O filtro
--      dos 10 dias vive so em casos_elegiveis_liberacao_fidelizacao (a lista que
--      o lote percorre); a funcao em si solta QUALQUER caso que receba, e tem
--      EXECUTE para `authenticated`. Sem guarda propria, qualquer chamada direta
--      ou qualquer chamador futuro quebra a regra.
--      Cron atual: fidelizacao_liberar_vencidos, 20 8 * * *.
--
--   2) nivelamento_automatico_gestao -- roda TODO DIA (cron
--      nivelamento_automatico_gestao, 20 9 * * *) e monta o pool olhando
--      encerramento, pagamento em transito e confirmacao financeira, mas NAO a
--      janela dos 10 dias. Por padrao a origem e a base da gestao
--      (amanda.seibel@aelbra.com.br), mas p_origens aceita qualquer e-mail.
--      Medido hoje: 32 casos na base da gestao, 0 dentro do prazo -- a guarda
--      entra sem mudar nada do que a rotina faz hoje.
--
-- FORA DESTA MIGRATION, de proposito (ver docs/DIAGNOSTICO-FIDELIZACAO-*.md):
-- saida por encerramento/saldo zero, trg_repor_caso_operador (caso fechado),
-- reposicao_carteira_processar (so pega caso sem dono), Carteira Geral e
-- alterar_responsavel_aluno (acao manual da gestao), trg_tabulacao_redireciona
-- (encaminhamento pedido pelo proprio operador) e os acordos.
--
-- FORMA: patch ANCORADO -- le o corpo vivo com pg_get_functiondef, troca so o
-- trecho da ancora e reexecuta. Idempotencia pelo texto NOVO; ancora ausente
-- derruba a migration. Nao mexe em score, teto, criterio de prioridade,
-- protecao financeira nem em ACL.

-- ---------------------------------------------------------------------------
-- 1) liberar_fidelizacao_caso: dentro do prazo, nao solta -- venha de onde vier.
-- ---------------------------------------------------------------------------
do $mig$
declare
  v_def text := pg_get_functiondef('public.liberar_fidelizacao_caso(uuid,text,text)'::regprocedure);
  v_ancora text := '  if not found or v_c.operador_email is null then return false; end if;';
  v_novo text := '  if not found or v_c.operador_email is null then return false; end if;
  -- Fidelizacao de 10 dias: dentro do prazo o caso nao e solto por caminho
  -- nenhum. Devolve false (nao levanta excecao) para o lote seguir em frente.
  if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento) then return false; end if;';
begin
  if position('caso_dentro_prazo_fidelizacao' in v_def) > 0 then
    raise notice 'liberar_fidelizacao_caso ja respeita a fidelizacao; nada a fazer.';
  else
    if position(v_ancora in v_def) = 0 then
      raise exception 'ancora nao encontrada em liberar_fidelizacao_caso';
    end if;
    execute replace(v_def, v_ancora, v_novo);
  end if;
end $mig$;

-- ---------------------------------------------------------------------------
-- 2) nivelamento_automatico_gestao: caso dentro do prazo nao entra no pool.
-- ---------------------------------------------------------------------------
do $mig$
declare
  v_def text := pg_get_functiondef('public.nivelamento_automatico_gestao(integer,boolean,text[])'::regprocedure);
  v_ancora text := '   where c.operador_email = any(p_origens)
     and coalesce(s.saldo_total,0) > 0';
  v_novo text := '   where c.operador_email = any(p_origens)
     -- Fidelizacao de 10 dias: quem foi acionado ha 10 dias ou menos fica com
     -- o responsavel atual, mesmo que o debito esteja vencido ha mais tempo.
     and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
     and coalesce(s.saldo_total,0) > 0';
begin
  if position('caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)' in v_def) > 0 then
    raise notice 'nivelamento_automatico_gestao ja respeita a fidelizacao; nada a fazer.';
  else
    if position(v_ancora in v_def) = 0 then
      raise exception 'ancora nao encontrada em nivelamento_automatico_gestao';
    end if;
    execute replace(v_def, v_ancora, v_novo);
  end if;
end $mig$;

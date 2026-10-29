-- ACOES MASSIVAS: "retorno agendado" so bloqueia quando foi o OPERADOR que agendou.
--
-- O QUE FOI MEDIDO EM PRODUCAO (2026-10-15, so leitura, doc
-- docs/ACOES-MASSIVAS-DATAS-E-COBERTURA-2026-10-15.md). Filtro declarado:
-- operador=todos, canal=WHATSAPP, MENSALIDADES_E_ACORDOS, recencia_dias=10.
--
--   universo 13.947 alunos
--   retorno_futuro 7.080 (50,8%) / R$ 14.134.518
--     AUTOMATICO 6.829 / R$ 13.168.152   <- 96,5%
--     OPERADOR     246 / R$    966.366
--     (nulo)         5 / R$          0
--   disponivel hoje 3.295
--
-- 5.790 dos automaticos tem retorno para o dia seguinte e 5.466 vieram da MESMA
-- campanha (06/10): a massiva avanca data_ultimo_acionamento, o
-- status_acionamento da massiva fica grudado no aluno (6.345 hoje) e
-- recalcular_situacao_aluno, no ramo COBRANCA_VENCIDA, reescreve
-- `data_retorno := ult_acion + 10` toda vez que e chamada (regra de 04/08/2026).
-- A 20261004103024 isentou o GATILHO de acionamento, nao os demais chamadores.
--
-- POR QUE MUDAR. "Retorno agendado para data futura" e lido pela gestao como
-- compromisso marcado por alguem. Em 96,5% dos casos nao houve agendamento
-- nenhum: e o proprio sistema devolvendo a janela da campanha anterior. Com
-- isso o bloqueio:
--   * duplica a recencia da acao massiva (os mesmos 10 dias), que ja existe e e
--     ajustavel na tela;
--   * ignora o canal -- a recencia e POR CANAL e o retorno e global, entao uma
--     campanha de WhatsApp bloqueia e-mail para o mesmo aluno;
--   * tem precedencia sobre `acao_massiva_recente`, entao a tela mostra o
--     motivo errado e o aluno parece ter sumido.
--
-- Mesma linha da decisao da gestao de 15/10 no painel "Meu dia": listar so o
-- retorno agendado pelo OPERADOR; o automatico vira contador, nao compromisso.
--
-- A REGRA NOVA. `f_ret` passa a exigir `retorno_origem` comecando em OPERADOR.
-- Quem tiver origem AUTOMATICO (ou nula) deixa de ser escondido por este
-- motivo -- e continua passando por TODAS as outras camadas, inclusive a
-- recencia da massiva no canal, que e quem deve segurar quem acabou de receber
-- a campanha.
--
-- O QUE NAO MUDA: quem o operador agendou de verdade segue protegido; nenhum
-- outro motivo, precedencia, fidelizacao, elegibilidade ou registro muda; nada
-- e escrito em alunos/casos (a funcao e leitura).
--
-- FORMA: patch ancorado, nunca reescrita. O corpo em producao e resultado de
-- varios patches (27/09 responsavel por lado, entre outros) e NAO e igual ao
-- arquivo 20260920125244 do repo.
--
-- SIMULACAO MEDIDA EM PRODUCAO, 15/10 (bloco DO que aplicou estes dois patches
-- e terminou em RAISE EXCEPTION -- nada persistiu; md5 da funcao antes e depois
-- = cb618e31cf9d821a5f53692b978911d0, `OPERADOR` e `retorno_origem` ausentes do
-- corpo vivo). Mesmo filtro declarado acima, universo 13.947 nos dois lados:
--
--   motivo                   ANTES                 DEPOIS
--   DISPONIVEL               3.289 / R$  6.971.172 -> 6.369 / R$ 15.570.043
--   retorno_futuro           7.091 / R$ 14.178.391 ->   251 / R$    971.680
--   acao_massiva_recente     2.236 / R$  1.980.190 -> 5.955 / R$  6.534.345
--   contato_indisponivel       349 / R$    420.939 ->   390 / R$    474.624
--   encerrado_operacional      419 / R$    133.489 ->   419  (identico)
--   liquidado_prime            248 / R$    546.066 ->   248  (identico)
--   confirmacao_pendente       190 / R$  1.248.810 ->   190  (identico)
--   fora_tipo_cobranca         125 / R$    435.852 ->   125  (identico)
--
-- LEITURA. Dos 6.840 que saem de `retorno_futuro`, 3.719 continuam bloqueados
-- pela RECENCIA do canal (e agora com o motivo certo na tela) e 41 por falta de
-- telefone. Entram de fato na fila **3.080 alunos / R$ 8.598.871**. Os quatro
-- motivos que nao tem relacao com retorno ficam identicos: o patch e cirurgico.
-- A soma dos motivos fecha o universo nos dois lados.
--
-- Os 251 que seguem bloqueados sao os agendamentos reais do operador -- era
-- isso que o motivo sempre quis dizer.

-- (1) o universo passa a enxergar a origem do retorno
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$a.responsavel_atual_email as resp, a.data_retorno,$ancora$,
$novo$a.responsavel_atual_email as resp, a.data_retorno, a.retorno_origem,$novo$,
  1);

-- (2) so o retorno agendado pelo operador bloqueia
select internal.patch_funcao_ancorada(
  'public', 'acoes_massivas_universo',
$ancora$(k.data_retorno is not null and k.data_retorno > v_hoje) as f_ret,$ancora$,
$novo$(k.data_retorno is not null and k.data_retorno > v_hoje and upper(coalesce(k.retorno_origem, '')) like 'OPERADOR%') as f_ret,$novo$,
  1);

comment on function public.acoes_massivas_universo(jsonb) is
  'Fonte unica das Acoes Massivas: 1 linha por aluno com divida ativa, com cobertura (acionado no mes/hoje, nunca) e disponibilidade (um motivo de indisponibilidade). O motivo retorno_futuro so considera retorno agendado pelo OPERADOR (retorno_origem OPERADOR%); retorno automatico da tabulacao nao esconde aluno -- quem segura a janela da campanha e a recencia por canal. Leitura pura; alimenta previa, painel por ano e drill-down.';

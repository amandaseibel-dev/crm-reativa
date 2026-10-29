-- Rollback de 20260927170000: 'alunos' volta a carregar a contagem de CASOS e
-- o campo 'casos' deixa de existir.
--
-- ATENCAO: reverter reintroduz o rotulo errado que confundiu a gestora ("11"
-- sob a coluna Alunos sendo contagem de caso), e a tela publicada, que le
-- r.casos, passa a cair no fallback r.alunos -- o numero continua aparecendo,
-- mas volta a ser caso rotulado como aluno.
--
-- Nenhum dado e movido aqui.

select internal.patch_funcao_ancorada(
  'public', 'carteira_geral_painel',
$ancora$                 -- CASOS e ALUNOS, separados: `_cg` tem uma linha por caso,
                 -- e chamar isso de "alunos" era o que fazia a gestora ler
                 -- "11" e entender que responde por 11 coisas.
                 'casos', count(*),
                 'alunos', count(distinct aluno_id),$ancora$,
$novo$                 'alunos', count(*),$novo$,
  1);

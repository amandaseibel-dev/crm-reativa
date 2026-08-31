-- Indice na expressao que o gatilho de vinculo usa. Sem ele a importacao morre.
--
-- Amanda, 31/08: "erro ao importar projecao pode verificar".
--
-- O QUE ACONTECEU. O gatilho `trg_pagamento_vincula_aluno` (BEFORE INSERT em
-- pagamentos, criado hoje mais cedo para o pagamento ja nascer vinculado ao
-- aluno) procura o aluno pelo nome normalizado. A busca varria a tabela
-- `alunos` INTEIRA -- 17.476 linhas -- aplicando regexp_replace + translate em
-- CADA registro. E fazia isso UMA VEZ POR LINHA IMPORTADA.
--
-- Medido em 31/08, antes: 127 ms por linha, 2.768 buffers, Seq Scan.
--                 depois:  1,4 ms por linha,     2 buffers, Index Scan.
--
-- Numa planilha de 3.000 pagamentos sao mais de 6 minutos so no gatilho -- o
-- statement timeout corta antes e a importacao inteira falha com 57014
-- (canceling statement due to statement timeout). Foi o que derrubou as duas
-- tentativas de importar a Projecao, as 11:26 e as 11:27 de 31/08.
--
-- Nada ficou pela metade: a transacao inteira voltou atras, sem linha em
-- `importacoes` nem em `pagamentos`. Conferido antes de aplicar isto.
--
-- A EXPRESSAO AQUI E IDENTICA A DO GATILHO, DE PROPOSITO. Se as duas divergirem
-- em um espaco que seja, o planejador ignora o indice e a lentidao volta sem
-- ninguem perceber -- e o sintoma so aparece na proxima importacao grande. Ao
-- mexer em `_pagamento_vincula_aluno_por_nome_unico`, mexer aqui junto.
--
-- DESFAZER: supabase/rollbacks/20260831100000_indice_nome_normalizado_destrava_importacao.rollback.sql

create index if not exists ix_alunos_nome_normalizado
  on public.alunos (
    translate(upper(regexp_replace(trim(nome), '\s+', ' ', 'g')),
              'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC')
  );

comment on index public.ix_alunos_nome_normalizado is
  'Serve o gatilho _pagamento_vincula_aluno_por_nome_unico. A expressao tem de bater EXATAMENTE com a do gatilho, senao vira Seq Scan de novo.';

analyze public.alunos;

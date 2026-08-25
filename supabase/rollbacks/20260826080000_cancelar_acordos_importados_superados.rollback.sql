-- Rollback de 20260826080000_cancelar_acordos_importados_superados.sql
--
-- Devolve status ATIVO aos 67 acordos e limpa a assinatura. So toca linhas
-- marcadas com `cancelamento_superado_20260826` -- acordos cancelados por
-- qualquer outro motivo nao sao afetados.
--
-- Reverter recoloca R$ 89.495,82 na carteira: acordos que o proprio aluno ja
-- substituiu por outro, sem nenhuma parcela paga, vencidos antes do novo
-- entrar. Reverta so se o criterio se mostrar errado -- e nesse caso vale
-- conferir os casos um a um antes, nao reativar o lote inteiro.

update public.acordos
   set status = 'ATIVO',
       atualizado_em = now(),
       motivo_ajuste = nullif(
         btrim(
           regexp_replace(
             coalesce(motivo_ajuste,''),
             '\s*\|?\s*cancelado por acordo mais recente do mesmo aluno \(cancelamento_superado_20260826\)',
             '', 'g'
           ), ' |'
         ), '')
 where motivo_ajuste like '%cancelamento_superado_20260826%';

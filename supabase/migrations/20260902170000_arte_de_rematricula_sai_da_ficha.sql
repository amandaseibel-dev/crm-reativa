-- A arte "Pedido de contato (rematricula)" sai da lista do operador.
--
-- Amanda, 02/09: "isso no crm os e-mails que os operadores podem enviar
-- primeira_abordagem / Pedido de contato (rematricula) / As rematriculas
-- comecaram -- vamos liberar a sua? -- essa quero ocultar".
--
-- POR QUE. A ficha do aluno monta os botoes de arte lendo `email_templates`
-- com `ativo = true` (src/components/EmailAlunoUnificado.jsx). A janela de
-- rematricula 2026/2 se encerrou, entao a arte que convida o aluno a liberar a
-- rematricula deixa de fazer sentido no discurso do operador.
--
-- NAO E EXCLUSAO. A linha continua na tabela com o texto intacto; so sai da
-- lista. Para trazer de volta, o rollback (ou `ativo = true`) basta.
--
-- A arte "Reta final das rematriculas" (chave `reta_final_matricula`) NAO foi
-- tocada -- Amanda apontou apenas esta.
--
-- Escrito depois do fato: aplicado em prod em 02/09 antes deste arquivo existir.
-- Guarda `if` de tabela porque `email_templates` so existe em prod hoje.

do $$
begin
  if to_regclass('public.email_templates') is not null then
    update public.email_templates
       set ativo = false
     where chave = 'primeira_abordagem';
  end if;
end $$;

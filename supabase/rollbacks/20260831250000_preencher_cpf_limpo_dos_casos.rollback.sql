-- DESFAZER 20260831250000_preencher_cpf_limpo_dos_casos.sql
--
-- ATENCAO: esvaziar `cpf_limpo` de novo reabre o buraco -- 219 casos com acordo
-- ATIVO voltam a NAO ser protegidos contra redistribuicao, e toda regra que
-- procura por CPF volta a falhar em silencio neles.
--
-- Nao ha motivo conhecido para desfazer: o valor gravado veio do CPF do proprio
-- aluno, nao foi inventado.

update public.casos c
   set cpf_limpo = b.cpf_limpo_antes
  from public._backup_cpf_limpo_casos_20260831 b
 where c.id = b.caso_id;

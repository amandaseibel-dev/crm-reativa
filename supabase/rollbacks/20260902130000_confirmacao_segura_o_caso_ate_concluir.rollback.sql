-- Desfaz 20260902130000_confirmacao_segura_o_caso_ate_concluir.
--
-- Volta `recalcular_situacao_aluno` para a definicao guardada em
-- _backup_funcoes ANTES do patch. Quem tem confirmacao pendente E saldo
-- vencido volta a receber data_retorno = HOJE -- ou seja, a Amanda volta a
-- precisar tabular por cima depois de mandar o aluno para a fila.
--
-- Nao desfaz a limpeza das datas: as linhas voltam a ser carimbadas sozinhas
-- no proximo evento do aluno.

begin;

do $$
declare d text;
begin
  select definicao into d
    from public._backup_funcoes
   where funcao = 'recalcular_situacao_aluno'
     and motivo = 'antes de 20260902130000_confirmacao_segura_o_caso_ate_concluir'
   order by guardado_em desc limit 1;

  if d is null then
    raise exception 'backup de recalcular_situacao_aluno nao encontrado';
  end if;

  execute d;
end $$;

commit;

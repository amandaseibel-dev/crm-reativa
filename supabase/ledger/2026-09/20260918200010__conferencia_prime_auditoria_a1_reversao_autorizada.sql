-- CONFERENCIA PRIME -- decisao da gestao apos a auditoria dos 407 A1 confirmados. So registra.
do $d$
begin
  if exists (select 1 from public.auditoria where acao = 'CONFERENCIA_PRIME_AUDITORIA_A1_REVERSAO_AUTORIZADA') then
    raise exception 'DECISAO: ja registrada';
  end if;
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFERENCIA_PRIME_AUDITORIA_A1_REVERSAO_AUTORIZADA', 'prime_conferencia_decisao', null,
          jsonb_build_object(
            'decisao', 'gestao 18/09/2026: os titulos A1 confirmados sem pagamento ReATIVA que cubra o valor (classes C e D da auditoria) '
                       || 'nao permanecem PAGO; voltam para EM_CONFIRMACAO com decisao PENDENTE e motivo AUDITORIA_GRUPO_A_EVIDENCIA_INSUFICIENTE',
            'motivo', 'a confirmacao anterior usou o valor_pago da Prime como evidencia de caixa; a auditoria comprovou que esse campo tambem '
                      || 'representa divida corrigida/renegociacao',
            'congelamento', 'nenhuma nova confirmacao A1 ate o fim desta correcao',
            'classe_a_intocada', jsonb_build_object('titulos', 36, 'alunos', 19, 'valor', 17104.06),
            'universo', jsonb_build_object('classe_c', jsonb_build_object('titulos', 143, 'alunos', 82, 'valor', 220017.11),
                                           'classe_d', jsonb_build_object('titulos', 228, 'alunos', 147, 'valor', 746679.73),
                                           'total', jsonb_build_object('titulos', 371, 'alunos', 229, 'valor', 966696.84)),
            'estado_de_retorno', 'EM_CONFIRMACAO / PENDENTE; nunca ABERTO nem cobranca',
            'aluno_quitado_so_por_estes_titulos', 'volta para AGUARDANDO_CONFIRMACAO, caso reaberto, responsavel anterior preservado; caso so-confirmacao nao ocupa vaga',
            'reposicoes', 'as 97 geradas pela confirmacao ficam neutralizadas com erro REVERSAO_AUDITORIA_GRUPO_A; reposicao segue PAUSADA',
            'proibido', 'regra global, reposicao, redistribuicao'));
end;
$d$;

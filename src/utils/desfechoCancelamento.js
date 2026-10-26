// Desfecho do cancelamento de acordo: rotulos e mensagem para o operador.
//
// Separado da tela de proposito -- e a regra de LEITURA do retorno de
// `cancelar_acordo_ficha`, e e ela que decide se o operador entende que a
// divida voltou a ficar negociavel ou nao. Mesmo padrao de
// `criticasImportacao.js`.
//
// O defeito que isto corrige (E5, 26/10/2026): a tela dizia "Acordo cancelado."
// em qualquer caso. Com zero vinculo tratado NENHUMA mensalidade volta para em
// aberto, e o operador concluia o contrario -- foi o que aconteceu no acordo
// 5692 do Pedro Henrique, e e o estado de 624 dos 677 acordos cancelados.
//
// COMPATIVEL COM A RPC ANTIGA: enquanto a migration da E5 nao for aplicada, o
// retorno nao traz `desfecho` e a mensagem cai no texto de sempre. Esta tela
// pode ir para producao antes da migration sem efeito nenhum.

export const DESFECHOS = {
  CANCELAMENTO_EFETIVO: {
    rotulo: "Cancelado",
    descricao: "Os vinculos foram desfeitos e as mensalidades passaram pela reavaliacao.",
    tom: "verde",
  },
  COMPOSICAO_AUSENTE: {
    rotulo: "Cancelado sem devolver mensalidade",
    descricao: "Nao havia vinculo para tratar: nenhuma mensalidade voltou para em aberto.",
    tom: "amarelo",
  },
  CONFERENCIA_NECESSARIA: {
    rotulo: "Cancelado, precisa de conferencia",
    descricao: "Sobrou mensalidade marcada como quitada por este acordo.",
    tom: "vermelho",
  },
};

export function rotuloDesfecho(desfecho) {
  return DESFECHOS[desfecho]?.rotulo || "Cancelado";
}

export function tomDoDesfecho(desfecho) {
  return DESFECHOS[desfecho]?.tom || "cinza";
}

const plural = (n, singular, plural_) => (Number(n) === 1 ? singular : plural_);

// Recebe o jsonb de `cancelar_acordo_ficha` e devolve o texto do aviso.
export function mensagemCancelamento(retorno) {
  if (!retorno || typeof retorno !== "object") return "Acordo cancelado.";

  const devolvidas = Number(retorno.mensalidades_devolvidas) || 0;
  const conferir = Number(retorno.titulos_conferir) || 0;
  const desativados = Number(retorno.vinculos_desativados) || 0;
  const total = Number(retorno.vinculos_total) || 0;

  if (retorno.desfecho === "CONFERENCIA_NECESSARIA") {
    return (
      `Acordo cancelado, mas ${conferir} ${plural(conferir, "mensalidade continua", "mensalidades continuam")} ` +
      `marcada${plural(conferir, "", "s")} como QUITADA${plural(conferir, "", "S")} por ele. ` +
      "Nada foi reaberto e nenhum pagamento foi desfeito. " +
      "Antes de abrir um acordo novo, a gestão financeira precisa conferir esses títulos — " +
      "o caso já ficou registrado na auditoria."
    );
  }

  if (retorno.desfecho === "COMPOSICAO_AUSENTE") {
    if (total === 0) {
      return (
        "Acordo cancelado, mas NENHUMA mensalidade foi devolvida: este acordo não tinha composição " +
        "registrada (nenhum título vinculado a ele). A dívida original segue exatamente como estava. " +
        "Confira no Prime quais mensalidades ele representava antes de abrir um acordo novo."
      );
    }
    return (
      "Acordo cancelado, mas NENHUMA mensalidade foi devolvida agora: " +
      `${total} ${plural(total, "vínculo dele já estava desfeito", "vínculos dele já estavam desfeitos")} ` +
      "antes deste cancelamento. A dívida original segue como estava."
    );
  }

  if (retorno.desfecho === "CANCELAMENTO_EFETIVO") {
    if (devolvidas > 0) {
      return (
        `Acordo cancelado. ${devolvidas} ${plural(devolvidas, "mensalidade voltou", "mensalidades voltaram")} ` +
        "para em aberto e já está disponível para uma nova negociação."
      );
    }
    return (
      `Acordo cancelado e ${desativados} ${plural(desativados, "vínculo desfeito", "vínculos desfeitos")}. ` +
      "Nenhuma mensalidade voltou para em aberto porque outro acordo da cadeia já recebeu pagamento — " +
      "a renegociação segue pelo saldo residual."
    );
  }

  return "Acordo cancelado.";
}

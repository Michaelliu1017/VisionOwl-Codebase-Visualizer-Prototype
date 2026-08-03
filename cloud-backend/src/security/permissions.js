"use strict";

const { CloudError } = require("../errors");

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

function validRole(role) {
  return Object.hasOwn(ROLE_RANK, role);
}

function requireRole(member, minimum) {
  if (!member || ROLE_RANK[member.role] < ROLE_RANK[minimum]) {
    throw new CloudError(
      member ? 403 : 404,
      member ? "permission_denied" : "project_not_found",
      member
        ? `This action requires the ${minimum} role.`
        : "Project not found.",
    );
  }
  return member;
}

module.exports = { ROLE_RANK, requireRole, validRole };

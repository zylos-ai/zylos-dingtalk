import { apiRequestV1 } from './client.js';

/**
 * Get user info by userId (staff ID).
 */
export async function getUserInfo(userId) {
  const result = await apiRequestV1('POST', '/topapi/v2/user/get', {
    userid: String(userId),
    language: 'zh_CN',
  });

  if (result.errcode === 0 && result.result) {
    const u = result.result;
    return {
      success: true,
      user: {
        userId: u.userid,
        name: u.name,
        email: u.email || '',
        mobile: u.mobile || '',
        avatar: u.avatar || '',
        department: u.dept_id_list || [],
        title: u.title || '',
        unionid: u.unionid || '',
      },
    };
  }
  return { success: false, message: `User lookup failed: ${result.errmsg}` };
}

/**
 * Get department user list.
 */
export async function getDepartmentUsers(deptId = 1) {
  const result = await apiRequestV1('POST', '/topapi/v2/user/listsimple', {
    dept_id: deptId,
    cursor: 0,
    size: 100,
  });

  if (result.errcode === 0 && result.result) {
    return {
      success: true,
      users: (result.result.list || []).map(u => ({
        userId: u.userid,
        name: u.name,
      })),
    };
  }
  return { success: false, message: `Dept listing failed: ${result.errmsg}` };
}
